# Validator App API Reference

Base URL: `http://localhost:3000` (Local) or `https://your-app.vercel.app` (Production)

## Authentication

### Login / Identify
**POST** `/api/login`

Identifies a user by name. Uses fuzzy matching to find the closest registered user.

**Request Body:**
```json
{
  "name": "John Doe"
}
```

**Response:**
```json
{
  "user": "John Doe"
}
```

---

## Validation Workflow

### Get Pair to Validate
**GET** `/api/pair?user={username}`

Fetches a song pair (original + candidate cover) for the user to validate. Returns pairs that have fewer than 3 validations.

**Query Parameters:**
- `user`: The username of the validator.

**Response:**
```json
{
  "original_id": "video_id_123",
  "original_title": "Song Title",
  "song_number": 1,
  "candidate": {
    "id": "cover_video_id_456",
    "title": "Song Title (Cover)",
    "uploader": "Cover Artist",
    "url": "https://youtube.com/..."
  },
  "original_index": "mongo_object_id",
  "candidate_index": 0
}
```

### Submit Vote
**POST** `/api/vote`

Submits a validation vote for a candidate cover.

**Request Body:**
```json
{
  "original_index": "mongo_object_id",
  "candidate_index": 0,
  "is_cover": true // true = Yes, false = No
}
```

**Response:**
```json
{
  "success": true
}
```

---

## Data Sync & Management

### Sync Data (Batch Upload)
**POST** `/api/sync`

Uploads a batch of scraped cover songs to the validator. Used by the scraper's `sync_manager.py`.

**Headers:**
- `Content-Type: application/json`

**Request Body:**
```json
{
  "songs": [
    {
      "original_id": "vid1",
      "original_title": "Title",
      "candidate_covers": [...]
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Sync complete. Inserted: 10, Updated: 5"
}
```

---

## Analytics & Exports

### Get Global Stats
**GET** `/api/votes`

Returns a list of all validated pairs and their vote counts.

**Response:**
```json
[
  {
    "user": "John",
    "original_title": "Song A",
    "candidate_title": "Cover B",
    "is_cover": true,
    "votes_yes": 2,
    "votes_no": 0
  }
]
```

### Get Final List
**GET** `/api/final-list`

Returns all songs that have confirmed covers (majority "Yes" votes).

**Response:**
```json
[
  {
    "original_title": "Song A",
    "candidate_covers": [ ...only confirmed covers... ]
  }
]
```
