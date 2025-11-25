require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const levenshtein = require('levenshtein');
const { User, Song } = require('./models');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB connection error:", err));

// Fuzzy match user
const findUser = async (inputName) => {
    const users = await User.find({});
    const normalizedInput = inputName.trim().toLowerCase();

    let bestMatch = 'others';
    let minDistance = Infinity;

    for (const user of users) {
        const name = user.name.toLowerCase();
        const distance = new levenshtein(normalizedInput, name).distance;

        if (distance < minDistance && distance <= 2) {
            minDistance = distance;
            bestMatch = user.name;
        }
    }

    return bestMatch;
};

// API: Login / Identify
app.post('/api/login', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });

    try {
        const assignedUser = await findUser(name);
        res.json({ user: assignedUser });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: Get Pair
app.get('/api/pair', async (req, res) => {
    const user = req.query.user;
    if (!user) return res.status(400).json({ error: "User required" });

    try {
        // Find songs assigned to this user
        // We need to find a song that has < 3 valid covers AND has at least one unvoted candidate
        // This is complex to query efficiently in one go, so we'll iterate or use aggregation if needed.
        // For simplicity with moderate data size:
        // Find all songs for user, then filter in code or use a smart query.

        // Query: assigned_user = user
        const songs = await Song.find({ assigned_user: user });

        // Iterate sequentially
        for (let i = 0; i < songs.length; i++) {
            const original = songs[i];
            if (!original.candidate_covers) continue;

            const validCoverCount = original.candidate_covers.filter(c => c.isCover === true).length;
            if (validCoverCount >= 3) continue;

            for (let j = 0; j < original.candidate_covers.length; j++) {
                const candidate = original.candidate_covers[j];

                if (candidate.isCover === undefined) {
                    return res.json({
                        original_id: original.original_id,
                        original_title: original.original_title,
                        song_number: original.song_number, // Return friendly ID
                        candidate: candidate,
                        original_index: original._id, // Use _id for DB lookup
                        candidate_index: j // We still need index or ID to find subdoc
                    });
                }
            }
        }

        res.json({ message: "All pairs validated for this user!" });
    } catch (error) {
        console.error("Error getting pair:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: Vote
app.post('/api/vote', async (req, res) => {
    const { original_index, candidate_index, is_cover } = req.body; // original_index is now the Song _id

    try {
        const song = await Song.findById(original_index);
        if (!song || !song.candidate_covers[candidate_index]) {
            return res.status(404).json({ error: "Pair not found" });
        }

        const candidate = song.candidate_covers[candidate_index];

        if (!candidate.is_cover_votes) candidate.is_cover_votes = 0;
        if (!candidate.is_not_cover_votes) candidate.is_not_cover_votes = 0;

        if (is_cover) {
            candidate.is_cover_votes += 1;
        } else {
            candidate.is_not_cover_votes += 1;
        }

        candidate.isCover = candidate.is_cover_votes > candidate.is_not_cover_votes;
        candidate.vote_timestamp = new Date();

        await song.save();
        res.json({ success: true });

    } catch (error) {
        console.error("Error voting:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: Stats (Global)
app.get('/api/votes', async (req, res) => {
    try {
        // Aggregation to get all voted candidates
        const songs = await Song.find({ "candidate_covers.isCover": { $ne: null } });
        const votedPairs = [];

        songs.forEach(original => {
            original.candidate_covers.forEach(candidate => {
                if (candidate.isCover !== undefined) {
                    votedPairs.push({
                        user: original.assigned_user,
                        original_title: original.original_title,
                        candidate_title: candidate.title,
                        candidate_id: candidate.id,
                        is_cover: candidate.isCover,
                        votes_yes: candidate.is_cover_votes,
                        votes_no: candidate.is_not_cover_votes
                    });
                }
            });
        });

        res.json(votedPairs);
    } catch (error) {
        console.error("Error getting stats:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: Final List (Dynamic)
// We don't need to write to a file anymore, we can serve it on demand or user can just query DB.
// But if user wants a JSON download, we can provide an endpoint.
app.get('/api/final-list', async (req, res) => {
    try {
        const songs = await Song.find({ "candidate_covers.isCover": true });

        const finalData = songs.reduce((acc, item) => {
            const confirmedCovers = item.candidate_covers.filter(c => c.isCover === true);
            if (confirmedCovers.length > 0) {
                // Mongoose documents are immutable-ish, convert to object
                const newItem = item.toObject();
                newItem.candidate_covers = confirmedCovers;
                acc.push(newItem);
            }
            return acc;
        }, []);

        res.json(finalData);
    } catch (error) {
        res.status(500).json({ error: "Error generating list" });
    }
});

// API: Validated Covers (Full Dump)
app.get('/api/validated-covers', async (req, res) => {
    try {
        const songs = await Song.find({});
        res.json(songs);
    } catch (error) {
        console.error("Error getting validated covers:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Helper for analytics
const calculateStats = (songs) => {
    let total_originals = songs.length;
    let originals_with_at_least_1_cover = 0;
    let originals_with_3_covers = 0;
    let originals_fully_rejected = 0;
    let originals_pending = 0;
    let total_covers_found = 0;
    let total_votes = 0;

    songs.forEach(song => {
        const candidates = song.candidate_covers || [];

        // Count confirmed covers
        const confirmedCovers = candidates.filter(c => c.isCover === true).length;
        if (confirmedCovers >= 1) originals_with_at_least_1_cover++;
        if (confirmedCovers >= 3) originals_with_3_covers++;
        total_covers_found += confirmedCovers;

        // Count votes
        candidates.forEach(c => {
            total_votes += (c.is_cover_votes || 0) + (c.is_not_cover_votes || 0);
        });

        // Fully rejected: All candidates voted and all are NOT covers
        // We need to check if all candidates have a decision (isCover !== undefined) and all are false
        // And there must be at least one candidate
        if (candidates.length > 0) {
            const allDecided = candidates.every(c => c.isCover !== undefined);
            const allRejected = candidates.every(c => c.isCover === false);
            if (allDecided && allRejected) {
                originals_fully_rejected++;
            }
        }

        // Pending: No votes cast on any candidate
        const noVotesCast = candidates.every(c => (c.is_cover_votes || 0) === 0 && (c.is_not_cover_votes || 0) === 0);
        if (noVotesCast) {
            originals_pending++;
        }
    });

    return {
        total_originals,
        originals_with_at_least_1_cover,
        originals_with_3_covers,
        originals_fully_rejected,
        originals_pending,
        total_covers_found,
        total_votes
    };
};

// API: Global Analytics
app.get('/api/analytics/global', async (req, res) => {
    try {
        const songs = await Song.find({});
        const stats = calculateStats(songs);
        res.json(stats);
    } catch (error) {
        console.error("Error getting global analytics:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: User Analytics
app.get('/api/analytics/user/:name', async (req, res) => {
    const { name } = req.params;
    try {
        // Find user to get exact name if needed, or just query by assigned_user
        // Assuming name passed is the exact assigned_user string or we fuzzy match again?
        // The frontend likely sends the exact name from login.

        const songs = await Song.find({ assigned_user: name });
        const stats = calculateStats(songs);

        // Additional User Stats
        stats.songs_assigned = songs.length;

        // Find last vote
        let lastVotedTime = new Date(0); // Epoch
        let lastPair = null;

        songs.forEach(song => {
            if (song.candidate_covers) {
                song.candidate_covers.forEach(c => {
                    if (c.vote_timestamp) {
                        const voteTime = new Date(c.vote_timestamp);
                        if (voteTime > lastVotedTime) {
                            lastVotedTime = voteTime;
                            lastPair = {
                                original_title: song.original_title,
                                original_id: song.original_id,
                                candidate_title: c.title,
                                candidate_id: c.id,
                                is_cover: c.isCover,
                                vote_timestamp: c.vote_timestamp
                            };
                        }
                    }
                });
            }
        });

        stats.last_voted = lastVotedTime.getTime() === 0 ? null : lastVotedTime;
        stats.last_pair = lastPair;

        res.json(stats);
    } catch (error) {
        console.error("Error getting user analytics:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: Sync (Batch Update from Scraper)
app.post('/api/sync', async (req, res) => {
    const { songs } = req.body;
    if (!songs || !Array.isArray(songs)) {
        return res.status(400).json({ error: "Invalid data format. 'songs' array required." });
    }

    try {
        let upsertedCount = 0;
        let insertedCount = 0;

        // Get all users for round-robin assignment if needed
        const users = await User.find({});
        const userNames = users.map(u => u.name);
        const buckets = [...userNames, 'others'];

        for (const songData of songs) {
            // Check if song exists
            let song = await Song.findOne({ original_id: songData.original_id });

            if (song) {
                // Update existing song
                // We merge candidate covers, avoiding duplicates by ID
                const existingIds = new Set(song.candidate_covers.map(c => c.id));
                const newCandidates = songData.candidate_covers.filter(c => !existingIds.has(c.id));

                if (newCandidates.length > 0) {
                    song.candidate_covers.push(...newCandidates);
                    await song.save();
                    upsertedCount++;
                }
            } else {
                // Insert new song
                // Assign user (simple random or round-robin logic for now)
                // For better distribution, we could query counts, but random is okay for sync
                const assignedUser = buckets[Math.floor(Math.random() * buckets.length)];

                // Calculate a song_number (max + 1)
                // This is expensive in loop, maybe just use timestamp or random for now if not critical
                // Or let MongoDB handle ID. We used song_number for display.
                // Let's just use 0 or handle it later if display needs it strictly sequential.

                const newSong = new Song({
                    ...songData,
                    assigned_user: assignedUser,
                    song_number: Date.now() // Temporary unique number
                });
                await newSong.save();
                insertedCount++;
            }
        }

        res.json({
            success: true,
            message: `Sync complete. Inserted: ${insertedCount}, Updated: ${upsertedCount}`
        });

    } catch (error) {
        console.error("Sync error:", error);
        res.status(500).json({ error: "Internal server error during sync" });
    }
});

// Export for Vercel
module.exports = app;

// Only listen if not running in Vercel (Vercel handles the port)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
