# site

This package contains the Agentic Sessions Dashboard web application. It runs
entirely in the browser: session files are parsed in Web Workers and stored in
a local SQLite database using `@sqlite.org/sqlite-wasm` with the OPFS VFS.

The sections below cover S3 sync configuration and security expectations for
self-hosted storage backends.

## CORS configuration

Browser `fetch` requests to S3 require the bucket to expose a CORS
configuration that allows the dashboard's origin. If the bucket CORS policy is
missing or too restrictive, `headBucket` will fail with `TypeError: Failed to
fetch`, which the app reports as a **possible CORS misconfiguration**.

Apply the following bucket CORS policy, replacing `https://<your-pages-domain>`
with the domain where the dashboard is hosted. `http://localhost:5173` is
included for local development with Vite:

```json
[{
  "AllowedOrigins": ["https://<your-pages-domain>", "http://localhost:5173"],
  "AllowedMethods": ["GET", "HEAD", "PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

`GET`, `HEAD`, and `PUT` are used for listing, checking, and uploading the
project manifest. `ETag` is exposed so the sync worker can validate the
uploaded object.

## IAM policy

The only S3 write operation performed by the site is a `PutObject` for the
project manifest. Sync workers read existing objects, but no other objects are
uploaded, modified, or deleted by the dashboard.

A minimal IAM policy for the sync user is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::<your-bucket>",
        "arn:aws:s3:::<your-bucket>/*"
      ]
    }
  ]
}
```

Because `PutObject` is only used to write the project manifest, it can be
further scoped to a specific key prefix if desired:

```json
"Resource": [
  "arn:aws:s3:::<your-bucket>",
  "arn:aws:s3:::<your-bucket>/path/to/manifest/*"
]
```

## Security notes

- **Secrets at rest** are encrypted with AES-GCM, derived via PBKDF2 with
  310,000 iterations, and each field uses a unique IV.
- **Passkey and derived key** exist only in memory while the app is running.
- **Decrypted credentials** are posted to sync workers at spawn time and are
  never written to storage, logs, or error messages.
- **File buffers** are transferred (not copied) into Web Workers and dropped
  after parsing; they are never persisted.
- **No secrets in outputs** — logs, error messages, `sync_details`, and the
  exported `.sqlite` database contain only the encrypted ciphertext blobs.
- **`.sqlite` export caveat** — if a user exports the local database, that file
  still contains only encrypted secrets; it must not include plaintext
  credentials.
- **Transcripts remain local-first** — downloading from S3 happens only on an
  explicit user-initiated sync.
