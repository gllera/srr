package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const (
	s3ErrNoSuchKey          = "NoSuchKey"
	s3ErrUnauthorized       = "Unauthorized"
	s3ErrPreconditionFailed = "PreconditionFailed"
)

var s3Cfg S3Config

type S3Config struct {
	Region          string `yaml:"region"`
	Endpoint        string `yaml:"endpoint"`
	Profile         string `yaml:"profile"`
	AccessKeyID     string `yaml:"access-key-id"`
	SecretAccessKey string `yaml:"secret-access-key"`
	SessionToken    string `yaml:"session-token"`
}

func init() {
	Register("s3", newS3)
	RegisterConfig("s3", &s3Cfg)
}

type S3 struct {
	bucket string
	path   string
	client *s3.Client
}

func newS3(ctx context.Context, u *url.URL) (Backend, error) {
	var opts []func(*config.LoadOptions) error

	if s3Cfg.Region != "" {
		opts = append(opts, config.WithRegion(s3Cfg.Region))
	}
	if s3Cfg.Profile != "" {
		opts = append(opts, config.WithSharedConfigProfile(s3Cfg.Profile))
	}
	if s3Cfg.AccessKeyID != "" {
		opts = append(opts, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(s3Cfg.AccessKeyID, s3Cfg.SecretAccessKey, s3Cfg.SessionToken),
		))
	}

	cfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, err
	}

	if s3Cfg.Endpoint != "" {
		cfg.BaseEndpoint = aws.String(s3Cfg.Endpoint)
	}

	return &S3{
		bucket: u.Host,
		path:   strings.TrimPrefix(u.Path, "/"),
		client: s3.NewFromConfig(cfg),
	}, nil
}

func (d *S3) s3path(op, key string) string {
	full := path.Join(d.path, key)
	slog.Debug("db "+op, "url", fmt.Sprintf("s3://%s/%s", d.bucket, full))
	return full
}

func apiErrorCode(err error) string {
	if apiErr, ok := errors.AsType[smithy.APIError](err); ok {
		return apiErr.ErrorCode()
	}
	return ""
}

func (d *S3) Get(ctx context.Context, key string, ignoreMissing bool) ([]byte, error) {
	key = d.s3path("read", key)

	res, err := d.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket:       aws.String(d.bucket),
		Key:          aws.String(key),
		ChecksumMode: types.ChecksumModeEnabled,
	})

	switch apiErrorCode(err) {
	case s3ErrNoSuchKey:
		if ignoreMissing {
			return nil, nil
		}
		return nil, fmt.Errorf("key %q not found on s3", key)
	case s3ErrUnauthorized:
		return nil, fmt.Errorf("unauthorized access to s3")
	}
	if err != nil {
		return nil, fmt.Errorf("s3 get %q: %w", key, err)
	}

	defer res.Body.Close()
	buf := new(bytes.Buffer)
	if _, err := buf.ReadFrom(res.Body); err != nil {
		return nil, fmt.Errorf("reading s3 response body: %w", err)
	}

	return buf.Bytes(), nil
}

func (d *S3) Put(ctx context.Context, key string, val []byte, ignoreExisting bool) error {
	key = d.s3path("write", key)

	var condition *string
	if !ignoreExisting {
		condition = aws.String("*")
	}

	_, err := d.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:            aws.String(d.bucket),
		Key:               aws.String(key),
		Body:              bytes.NewReader(val),
		IfNoneMatch:       condition,
		ChecksumAlgorithm: types.ChecksumAlgorithmCrc32,
	})

	switch apiErrorCode(err) {
	case s3ErrPreconditionFailed:
		return fmt.Errorf("key %q already exists on s3", key)
	case s3ErrUnauthorized:
		return fmt.Errorf("unauthorized access to s3")
	}
	if err != nil {
		return fmt.Errorf("s3 put %q: %w", key, err)
	}

	return nil
}

func (d *S3) AtomicPut(ctx context.Context, key string, val []byte) error {
	return d.Put(ctx, key, val, true)
}

func (d *S3) Rm(ctx context.Context, key string) error {
	key = d.s3path("delete", key)

	_, err := d.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(d.bucket),
		Key:    aws.String(key),
	})
	return err
}

func (d *S3) Close() error {
	return nil
}
