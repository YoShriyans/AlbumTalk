import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const { Pool } = pg;

// ✅ Use connection pool instead of single client
const db = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: { rejectUnauthorized: false },
  max: 2, // Reduced for free tier
  min: 0, // Don't maintain idle connections
  idleTimeoutMillis: 10000, // Close idle connections faster
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true, // Allow pool to close when idle
});

db.on('connect', () => console.log('✅ Connected to Supabase Transaction Pooler'));
db.on('error', (err) => console.error('❌ Database error:', err.stack));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Spotify API credentials
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Function to get Spotify access token
const getSpotifyToken = async () => {
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
        ).toString('base64')}`,
      },
    }
  );
  return response.data.access_token;
};

// ---------------- ROUTES ----------------

app.get('/getcomments', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing album ID' });

  try {
    const response = await db.query('SELECT * FROM usercomments WHERE id = $1', [id]);
    res.json(response.rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

app.post('/submitcomment', async (req, res) => {
  const { comment, id, date } = req.body;
  try {
    await db.query(
      'INSERT INTO usercomments (usercomment, id, created_at) VALUES ($1, $2, $3)',
      [comment, id, date]
    );
    res.json({ message: 'Comment submitted successfully' });
  } catch (err) {
    console.error('Error submitting comment:', err);
    res.status(500).json({ error: 'Failed to submit comment', details: err.message });
  }
});

app.get('/topalbums', async (req, res) => {
  try {
    console.log('🔍 Attempting to fetch top albums...');
    
    // Test database connection first
    const testQuery = await db.query('SELECT NOW()');
    console.log('✅ Database connection OK:', testQuery.rows[0]);
    
    const response = await db.query(
      'SELECT * FROM ratings ORDER BY rating DESC, count DESC LIMIT 3'
    );
    
    console.log('✅ Query executed, rows returned:', response.rows.length);
    res.json(response.rows.length > 0 ? response.rows : []);
  } catch (err) {
    console.error('❌ Error fetching top albums:', err);
    console.error('Error details:', {
      message: err.message,
      code: err.code,
      stack: err.stack
    });
    res.status(500).json({ 
      error: 'Failed to fetch top albums',
      details: err.message,
      code: err.code
    });
  }
});

app.post('/api', async (req, res) => {
  try {
    const { album, artist } = req.body;
    const token = await getSpotifyToken();

    let query = `album:${album}`;
    if (artist) query += ` artist:${artist}`;

    const response = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(
        query
      )}&type=album&limit=12`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const releases = response.data.albums.items.map((album) => ({
      id: album.id,
      title: album.name,
      artist: album.artists.map((a) => a.name).join(', '),
      release_date: album.release_date,
      cover_art: album.images.length > 0 ? album.images[0].url : null,
      url: album.external_urls.spotify,
    }));

    res.json({ releases });
  } catch (error) {
     console.error("Spotify status:", error.response?.status);
  console.error("Spotify response:", error.response?.data);
  console.error("Spotify URL:", error.config?.url);

  res.status(500).json({
    error: "Failed to fetch album data",
    details: error.response?.data || error.message
  });
  }
});

app.post('/albumpage', async (req, res) => {
  try {
    const { albumId } = req.body;
    const token = await getSpotifyToken();

    const albumResponse = await axios.get(
      `https://api.spotify.com/v1/albums/${albumId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const albumData = albumResponse.data;
    const artistId = albumData.artists?.[0]?.id;
    let artistImgUrl = null;

    if (artistId) {
      const artistResponse = await axios.get(
        `https://api.spotify.com/v1/artists/${artistId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      artistImgUrl = artistResponse.data.images?.[0]?.url || null;
    }

    res.json({ albumData, artistImgUrl });
  } catch (error) {
    console.error('Error fetching album details:', error.message);
    res.status(500).json({ error: 'Failed to fetch album details', details: error.message });
  }
});

app.post('/submitrating', async (req, res) => {
  const { id, name, newrating, artist, img } = req.body;
  try {
    const current = await db.query('SELECT * FROM ratings WHERE id = $1', [id]);

    if (current.rows.length > 0) {
      const { rating, count } = current.rows[0];
      const avg = (rating * count + newrating) / (count + 1);
      await db.query('UPDATE ratings SET rating = $1, count = $2 WHERE id = $3', [
        avg,
        count + 1,
        id,
      ]);
    } else {
      await db.query(
        'INSERT INTO ratings (id, name, rating, count, artist, image) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, name, newrating, 1, artist, img]
      );
    }

    res.json({ message: 'Rating updated successfully' });
  } catch (error) {
    console.error('Error updating rating:', error.message);
    res.status(500).json({ error: 'Failed to update rating', details: error.message });
  }
});

app.get('/getratings', async (req, res) => {
  let { albumIds } = req.query;
  if (!albumIds) return res.status(400).json({ error: 'No album IDs provided' });

  if (!Array.isArray(albumIds)) albumIds = albumIds.split(',');

  try {
    const result = await db.query('SELECT id, rating FROM ratings WHERE id = ANY($1)', [
      albumIds,
    ]);
    const ratingsData = {};
    result.rows.forEach((row) => (ratingsData[row.id] = row.rating));
    res.json(ratingsData);
  } catch (error) {
    console.error('Error fetching ratings:', error.message);
    res.status(500).json({ error: 'Failed to retrieve ratings', details: error.message });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const client = await db.connect();
  try {
    const result = await client.query('SELECT NOW()');
    res.json({ 
      status: 'healthy', 
      database: 'connected',
      timestamp: result.rows[0].now,
      poolInfo: {
        total: db.totalCount,
        idle: db.idleCount,
        waiting: db.waitingCount
      }
    });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ 
      status: 'unhealthy', 
      database: 'disconnected',
      error: err.message,
      code: err.code
    });
  } finally {
    client.release();
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment check:`);
  console.log(`   DB_HOST: ${process.env.DB_HOST ? '✅' : '❌'}`);
  console.log(`   DB_NAME: ${process.env.DB_NAME ? '✅' : '❌'}`);
  console.log(`   DB_USER: ${process.env.DB_USER ? '✅' : '❌'}`);
  console.log(`   DB_PASSWORD: ${process.env.DB_PASSWORD ? '✅' : '❌'}`);
});
