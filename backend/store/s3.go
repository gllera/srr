package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const (
	s3ErrNoSuchKey = "NoSuchKey"
	// s3ErrNotFound is HeadObject's missing-key code: HEAD responses carry no
	// body, so the SDK maps them to the generic NotFound instead of NoSuchKey.
	s3ErrNotFound           = "NotFound"
	s3ErrUnauthorized       = "Unauthorized"
	s3ErrPreconditionFailed = "PreconditionFailed"
)

var s3Cfg S3Config

type S3Config struct {
	Region          string `yaml:"region"`
	Endpoint        string `yaml:"endpoint"`
	Profile         string `yaml:"profile"`
	AccessKeyID     string `yaml:"access-key-id"`
	SecretAccessKey string `yaml:"secret-access-key" secret:"true"`
	SessionToken    string `yaml:"session-token" secret:"true"`
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

// s3Clients memoizes the SDK client per resolved config, so the serve loop's
// per-cycle store.Open (and every serve-API request's withDB scope) reuses one
// client — with its transport pool and lazily-refreshing credential cache —
// instead of rebuilding config + transport 288×/day. The client is
// bucket-agnostic (the bucket rides each op), so one entry serves every store
// URL under the same config; a config change (tests, env override) simply
// keys a fresh entry.
var (
	s3ClientsMu sync.Mutex
	s3Clients   = map[S3Config]*s3.Client{}
)

func s3ClientFor(ctx context.Context, c S3Config) (*s3.Client, error) {
	s3ClientsMu.Lock()
	defer s3ClientsMu.Unlock()
	if cl, ok := s3Clients[c]; ok {
		return cl, nil
	}

	var opts []func(*config.LoadOptions) error
	if c.Region != "" {
		opts = append(opts, config.WithRegion(c.Region))
	}
	if c.Profile != "" {
		opts = append(opts, config.WithSharedConfigProfile(c.Profile))
	}
	if c.AccessKeyID != "" {
		opts = append(opts, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, c.SessionToken),
		))
	}

	cfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("loading AWS config: %w", err)
	}

	if c.Endpoint != "" {
		cfg.BaseEndpoint = aws.String(c.Endpoint)
	}

	cl := s3.NewFromConfig(cfg)
	s3Clients[c] = cl
	return cl, nil
}

func newS3(ctx context.Context, u *url.URL) (Backend, error) {
	client, err := s3ClientFor(ctx, s3Cfg)
	if err != nil {
		return nil, err
	}
	return &S3{
		bucket: u.Host,
		path:   strings.TrimPrefix(u.Path, "/"),
		client: client,
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

func (d *S3) Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
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
		return nil, fmt.Errorf("unauthorized access to s3: %w", err)
	}
	if err != nil {
		return nil, fmt.Errorf("s3 get %q: %w", key, err)
	}

	return res.Body, nil
}

func (d *S3) Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error {
	return d.put(ctx, key, r, ignoreExisting, ObjectMeta{})
}

func (d *S3) AtomicPut(ctx context.Context, key string, r io.Reader, meta ObjectMeta) error {
	return d.put(ctx, key, r, true, meta)
}

// put is the shared write core. Content-Type comes from meta (the asset-peek /
// asset-process mimetype), then contentTypeForKey (SRR's own gzip objects —
// db.gz + pack-grammar names — declare application/gzip), then the
// application/octet-stream default — SRR still never guesses an asset's type
// from the key extension or by sniffing the bytes, since peek/process is the
// single source of truth there. Content-Encoding is stamped only when meta
// sets it; pack writes never set it (the reader gunzips manually — see
// contentTypeGzip).
func (d *S3) put(ctx context.Context, key string, r io.Reader, ignoreExisting bool, meta ObjectMeta) error {
	// Resolve the cache class and key-derived type from the logical key before
	// it gets the path prefix, so the CDN serves finalized packs immutable and
	// db.gz/latest always-revalidate.
	cacheControl := cacheControlForKey(key)
	contentType := meta.ContentType
	if contentType == "" {
		contentType = contentTypeForKey(key)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	key = d.s3path("write", key)

	var condition *string
	if !ignoreExisting {
		condition = aws.String("*")
	}

	input := &s3.PutObjectInput{
		Bucket:            aws.String(d.bucket),
		Key:               aws.String(key),
		Body:              r,
		ContentType:       aws.String(contentType),
		IfNoneMatch:       condition,
		ChecksumAlgorithm: types.ChecksumAlgorithmCrc32,
	}
	if meta.ContentEncoding != "" {
		input.ContentEncoding = aws.String(meta.ContentEncoding)
	}
	if cacheControl != "" {
		input.CacheControl = aws.String(cacheControl)
	}

	_, err := d.client.PutObject(ctx, input)

	switch apiErrorCode(err) {
	case s3ErrPreconditionFailed:
		return fmt.Errorf("key %q already exists on s3: %w", key, os.ErrExist)
	case s3ErrUnauthorized:
		return fmt.Errorf("unauthorized access to s3: %w", err)
	}
	if err != nil {
		return fmt.Errorf("s3 put %q: %w", key, err)
	}

	return nil
}

// Stat returns the object's size via HeadObject (no body transfer); a missing
// key is (0, nil) per the Backend contract.
func (d *S3) Stat(ctx context.Context, key string) (int64, error) {
	key = d.s3path("stat", key)

	res, err := d.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(d.bucket),
		Key:    aws.String(key),
	})

	switch apiErrorCode(err) {
	case s3ErrNotFound, s3ErrNoSuchKey:
		slog.Debug("db not found", "key", key)
		return 0, nil
	case s3ErrUnauthorized:
		return 0, fmt.Errorf("unauthorized access to s3: %w", err)
	}
	if err != nil {
		return 0, fmt.Errorf("s3 head %q: %w", key, err)
	}
	return aws.ToInt64(res.ContentLength), nil
}

func (d *S3) Rm(ctx context.Context, key string) error {
	key = d.s3path("delete", key)

	_, err := d.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(d.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		// Wrap like Local.Rm/SFTP.Rm so a delete failure names the op + key (GC
		// sweep warnings are warn-only and otherwise opaque). S3 treats a
		// missing-key delete as success, so no not-found branch is needed.
		return fmt.Errorf("s3 delete %q: %w", key, err)
	}
	return nil
}

func (d *S3) Close() error {
	return nil
}
