import Fastify from 'fastify';
import sqlite3 from 'better-sqlite3';
import fetch from 'node-fetch';

const fastify = Fastify({ logger: { level: 'debug' } });
const db = new sqlite3('artworks_cache.db');

// --- Database Setup ---
db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        search_key TEXT UNIQUE,
        url TEXT,
        url_tall TEXT,
        artist TEXT,
        album TEXT,
        api_url TEXT,
        itunes_url TEXT,
        timestamp DATETIME
    )
`);

// Auto-Migration, falls die DB-Datei schon existiert und die neuen Spalten fehlen
try {
    db.exec("ALTER TABLE cache ADD COLUMN api_url TEXT;");
    db.exec("ALTER TABLE cache ADD COLUMN itunes_url TEXT;");
} catch (e) {
    // Juckt nicht, Spalten sind schon da.
}

// --- Helper Functions ---

const getCachedQuery = () => `
    SELECT url, url_tall, artist, album, api_url, itunes_url 
    FROM cache 
    WHERE search_key = ? 
    AND (
        ((url IS NOT NULL OR url_tall IS NOT NULL) AND timestamp > datetime('now', '-90 days'))
        OR 
        (url IS NULL AND url_tall IS NULL AND timestamp > datetime('now', '-1 day'))
    )
`;

async function getBearerToken(albumUrl) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    try {
        const response = await fetch(albumUrl, { headers });
        const html = await response.text();
        
        const jsPaths = [...html.matchAll(/(\/assets\/[^"]+\.js)/g)]
            .map(m => m[1])
            .filter(p => ['index', 'web-client', 'apple-music'].some(x => p.includes(x)));

        for (const jsPath of [...new Set(jsPaths)]) {
            const jsRes = await fetch(`https://music.apple.com${jsPath}`, { headers });
            const jsText = await jsRes.text();
            
            const tokenMatch = jsText.match(/["'](eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+)["']/);
            if (tokenMatch) {
                return tokenMatch[1];
            }
        }
    } catch (err) {
        fastify.log.error(`Token extraction failed: ${err.message}`);
    }
    return null;
}

async function fetchArtworkDetails(albumUrl) {
    const match = albumUrl.match(/music\.apple\.com\/([a-z]{2})\/album\/[^/]+\/(\d+)/);
    if (!match) return { error: true, apiUrl: null };

    const [_, storefront, albumId] = match;
    const token = await getBearerToken(albumUrl);
    if (!token) return { error: true, apiUrl: null };

    const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}?extend=editorialVideo&platform=web`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://music.apple.com',
        'User-Agent': 'Mozilla/5.0'
    };

    try {
        const res = await fetch(apiUrl, { headers });
        const data = await res.json();
        const attrs = data.data[0].attributes;
        const videos = attrs.editorialVideo || {};

        return {
            url: videos.motionDetailSquare?.video || null,
            url_tall: videos.motionDetailTall?.video || null,
            artist: attrs.artistName,
            album: attrs.name,
            apiUrl: apiUrl
        };
    } catch (err) {
        fastify.log.error(`AMP API failed: ${err.message}`);
        return { error: true, apiUrl: apiUrl };
    }
}

async function fetchByIsrc(isrc, storefront = 'us') {
    const token = await getBearerToken(`https://music.apple.com/${storefront}`);
    if (!token) return { error: true, apiUrl: null };

    const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/songs?filter[isrc]=${encodeURIComponent(isrc)}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://music.apple.com',
        'User-Agent': 'Mozilla/5.0'
    };

    try {
        const res = await fetch(apiUrl, { headers });
        const data = await res.json();
        const song = data.data?.[0];

        return {
            albumUrl: song?.attributes?.url || null,
            apiUrl
        };
    } catch (err) {
        fastify.log.error(`ISRC lookup failed: ${err.message}`);
        return { error: true, apiUrl };
    }
}

// --- Endpoints ---

fastify.get('/api/v1/artwork/url', async (request, reply) => {
    const { url } = request.query;
    const cached = db.prepare(getCachedQuery()).get(url);
    
    if (cached) {
        if (!cached.url && !cached.url_tall) {
            return reply.code(404).send({ 
                message: "No animated artwork found.",
                api_url: cached.api_url,
                itunes_url: cached.itunes_url
            });
        }
        return { 
            url: cached.url,
            url_tall: cached.url_tall,
            artist: cached.artist,
            album: cached.album,
            isCached: true 
        };
    }

    const details = await fetchArtworkDetails(url);
    const apiUrl = details?.apiUrl || null;
    
    if (!details || details.error || (!details.url && !details.url_tall)) {
        db.prepare("INSERT OR REPLACE INTO cache (search_key, url, url_tall, artist, album, api_url, itunes_url, timestamp) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, datetime('now'))")
          .run(url, apiUrl, url);
        return reply.code(404).send({ 
            message: "No animated artwork found.",
            api_url: apiUrl,
            itunes_url: url
        });
    }

    db.prepare("INSERT OR REPLACE INTO cache (search_key, url, url_tall, artist, album, api_url, itunes_url, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))")
      .run(url, details.url, details.url_tall, details.artist, details.album, apiUrl, url);

    return { 
        url: details.url, 
        url_tall: details.url_tall, 
        artist: details.artist, 
        album: details.album, 
        isCached: false 
    };
});

fastify.get('/api/v1/artwork/search', async (request, reply) => {
    const { artist, album, title, isrc, country } = request.query;
    const searchKey = isrc
        ? `isrc:${isrc.toLowerCase()}`
        : `${artist?.toLowerCase()}|${album?.toLowerCase()}|${title?.toLowerCase()}`;
    const cached = db.prepare(getCachedQuery()).get(searchKey);

    if (cached) {
        if (!cached.url && !cached.url_tall) {
            return reply.code(404).send({
                message: "No animated artwork found.",
                api_url: cached.api_url,
                itunes_url: cached.itunes_url
            });
        }
        return {
            url: cached.url,
            url_tall: cached.url_tall,
            artist: cached.artist,
            album: cached.album,
            isCached: true
        };
    }

    try {
        let best = null;
        let searchUrl = null;

        if (isrc) {
            const isrcResult = await fetchByIsrc(isrc, (country || 'us').toLowerCase());
            searchUrl = isrcResult.apiUrl;
            if (isrcResult.albumUrl) {
                best = { collectionViewUrl: isrcResult.albumUrl };
            }
        }

        if (!best && (artist || album)) {
            const queryStr = title ? `${artist} ${album} ${title}` : `${artist} ${album}`;
            const query = encodeURIComponent(queryStr);
            const entity = title ? 'song' : 'album';
            searchUrl = `https://itunes.apple.com/search?term=${query}&entity=${entity}&limit=5&explicit=Yes`;

            const itunesRes = await fetch(searchUrl);
            const { results } = await itunesRes.json();

            if (results?.length) {
                const albumLower = album?.toLowerCase() ?? '';
                best = results.find(r => r.collectionName?.toLowerCase().includes(albumLower)) ?? results[0];
            }
        }

        if (!best) {
            db.prepare("INSERT OR REPLACE INTO cache (search_key, url, url_tall, artist, album, api_url, itunes_url, timestamp) VALUES (?, NULL, NULL, NULL, NULL, NULL, ?, datetime('now'))")
              .run(searchKey, searchUrl);
            return reply.code(404).send({
                message: "No animated artwork found.",
                api_url: null,
                itunes_url: searchUrl
            });
        }

        const itunesUrl = best.collectionViewUrl;

        const details = await fetchArtworkDetails(itunesUrl);
        const apiUrl = details?.apiUrl || null;

        if (!details || details.error || (!details.url && !details.url_tall)) {
            db.prepare("INSERT OR REPLACE INTO cache (search_key, url, url_tall, artist, album, api_url, itunes_url, timestamp) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, datetime('now'))")
              .run(searchKey, apiUrl, itunesUrl);
            return reply.code(404).send({ 
                message: "No animated artwork found.",
                api_url: apiUrl,
                itunes_url: itunesUrl
            });
        }

        db.prepare("INSERT OR REPLACE INTO cache (search_key, url, url_tall, artist, album, api_url, itunes_url, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))")
          .run(searchKey, details.url, details.url_tall, details.artist, details.album, apiUrl, itunesUrl);

        return { 
            url: details.url, 
            url_tall: details.url_tall, 
            artist: details.artist, 
            album: details.album, 
            isCached: false 
        };
    } catch (err) {
        return reply.code(404).send({ message: "No animated artwork found.", error: err.message });
    }
});

fastify.get('/clear', async (request, reply) => {
    const result = db.prepare("DELETE FROM cache WHERE url IS NULL AND url_tall IS NULL").run();
    return { 
        message: "Purge complete.",
        deleted_entries: result.changes 
    };
});

// --- Start Server ---
const start = async () => {
    try {
        const port = process.env.PORT || 3000;
        await fastify.listen({ port: parseInt(port), host: '0.0.0.0' });
        console.log(`Server läuft auf Port ${port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();