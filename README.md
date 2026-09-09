# Pickr Affiliate Portal — V2

A lightweight affiliate submission and approval dashboard that runs with Node.js only (no npm packages required).

## What changed in V2

Affiliate submissions now follow this workflow:

1. User full name
2. Pickr website username
3. Operator
4. Signup date
5. Up to 5 screenshots/files
6. Optional notes

Uploads are shown directly inside the admin review record.

### Supported uploads

- JPG / JPEG
- PNG
- WebP
- GIF
- HEIC / HEIF (common iPhone photo format)
- AVIF
- PDF

Maximum: **5 files per submission, 15 MB per file**.

The mobile form is designed for iPhone/Safari use. Affiliates can tap the upload area and select screenshots/photos from the iPhone picker. HEIC/HEIF files are accepted even when the browser cannot generate an inline thumbnail.

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Then open:

`http://127.0.0.1:3000`

No `npm install` is required for this version.

## Demo accounts

Admin:
- Email: `admin@demo.local`
- Password: `Admin123!`

Affiliate:
- Email: `affiliate@demo.local`
- Password: `Affiliate123!`

## Main workflow

### Affiliate
- Signs in with their own account.
- Submits the referred user's name, Pickr username, operator and signup date.
- Can attach up to five proof screenshots/files.
- Can see only their own records and uploaded files.
- Tracks Pending / Approved / Rejected / Needs Review status.

### Admin
- Sees submissions from every affiliate.
- Opens uploaded screenshots/files from the review modal.
- Approves, rejects, marks Needs Review, or returns a record to Pending.
- Adds an admin note with a decision.
- Creates and disables affiliate login accounts.
- Reviews the activity log.

## Duplicate protection

A Pickr username cannot be submitted twice for the same operator unless the previous record was rejected.

## Data storage

This local prototype stores:

- Users, submissions and activity in `data/db.json`
- Uploaded evidence files in `uploads/`

Both folders are excluded from Git by default.

## Before public deployment

This is a working local/internal prototype. Before exposing it publicly, move authentication, database storage and uploads to managed production services (for example Firebase Auth/Firestore/Cloud Storage), use HTTPS, add password-reset/email-verification flows, and configure backups and retention rules.
