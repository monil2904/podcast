# PodcastStudio 🎙️

A fully functional, browser-based podcast recording platform inspired by Riverside.fm. PodcastStudio allows a host to create a recording session and invite up to 3 remote guests via a shareable link. All participants connect using WebRTC (peer-to-peer video/audio), while the system records individual tracks and a combined global session directly to a Supabase cloud bucket.

![PodcastStudio Preview](https://via.placeholder.com/800x400?text=PodcastStudio)

## Features
- **Remote Peer-to-Peer:** Real-time, ultra-low latency WebRTC connection with automated TURN servers for traversing firewalls.
- **Admin Host View:** The host has full director controls (admit/kick guests, change dynamic layout arrangements, manage the global recording state).
- **Direct Cloud Recording:** No bulky local server storage! Uses the `MediaRecorder` API to capture individual tracks inside the browser, which are then streamed to Supabase.
- **Combined Session Track:** Dynamically captures the full layout and global audio via `getDisplayMedia()`.
- **Live Text Chat:** Built-in real-time socket messaging for the host and guests.

## Tech Stack
- **Frontend:** Vanilla JS, HTML5, CSS3 
- **Backend:** Node.js, Express.js
- **Real-time Signaling:** Socket.io
- **Database & Storage:** Supabase (PostgreSQL + S3-compatible Buckets)

## Quick Start (Local Development)

### 1. Requirements
- Node.js installed
- A free [Supabase](https://supabase.com/) account

### 2. Set up Supabase
1. Create a new Supabase project.
2. Run the following SQL in your Supabase SQL Editor:
```sql
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    host_name TEXT,
    title TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'waiting',
    recording_started_at TIMESTAMP WITH TIME ZONE,
    recording_ended_at TIMESTAMP WITH TIME ZONE
  );

  CREATE TABLE participants (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    role TEXT DEFAULT 'guest'
  );

  CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    participant_id TEXT,
    participant_name TEXT,
    type TEXT,
    filename TEXT,
    filesize BIGINT,
    url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
```
3. Create a **Storage Bucket** named `recordings`. Ensure it is set to "Public".
4. Set up an open Access Policy for the `recordings` bucket (Allow All).

### 3. Clone and Run
Clone this repository and create a `.env` file in the root directory:
```env
SUPABASE_URL=https://your-project-url.supabase.co
SUPABASE_KEY=your-service-role-secret-key
```

Install dependencies and start the server:
```bash
npm install
npm start
```
The app will be live at `http://localhost:3000`

## Deployment (Render.com)
Deploying PodcastStudio to Render is highly recommended since it automatically provisions HTTPS (mandatory for WebRTC cameras).

1. Push your repository to GitHub.
2. Create a new **Web Service** on Render connected to your repo.
3. Configure the service:
   - **Build Command:** `npm install`
   - **Start Command:** `node server/index.js` (or `npm start`)
4. Add your Environment Variables:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
5. Once deployed, Render will provide a public link (e.g., `https://podcast-studio.onrender.com`). You can send this link to anyone in the world to join your recording sessions!
