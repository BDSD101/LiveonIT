require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const CSV_FILE = path.join(__dirname, '../frontend/suburb_regions_ratings_google_api_centre_final.csv');

async function migrate() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    });

    try {
        await client.connect();
        console.log('Connected to PostgreSQL successfully.');

        // 1. Create the table
        await client.query(`
            CREATE TABLE IF NOT EXISTS suburb_ratings (
                id SERIAL PRIMARY KEY,
                suburb VARCHAR(255) UNIQUE NOT NULL,
                region VARCHAR(100) NOT NULL,
                rating DECIMAL(4, 2) NOT NULL
            );
        `);
        console.log('Table suburb_ratings created or already exists.');

        // 2. Read the CSV data
        const csvData = fs.readFileSync(CSV_FILE, 'utf-8');
        const lines = csvData.split('\n').filter(l => l.trim() !== '');
        const dataLines = lines.slice(1); // skip header

        console.log(`Read ${dataLines.length} suburbs from CSV.`);

        // 3. Clear existing data to avoid conflicts on re-runs
        await client.query('TRUNCATE TABLE suburb_ratings RESTART IDENTITY;');
        console.log('Cleared existing data.');

        // 4. Insert data into the database
        let successCount = 0;
        
        // We will insert them in bulk or a batch transaction
        await client.query('BEGIN');
        
        for (const line of dataLines) {
            const [suburb, region, ratingStr] = line.split(',');
            const rating = parseFloat(ratingStr) || 0;
            
            await client.query(
                `INSERT INTO suburb_ratings (suburb, region, rating) VALUES ($1, $2, $3)
                 ON CONFLICT (suburb) DO UPDATE SET region = EXCLUDED.region, rating = EXCLUDED.rating;`,
                [suburb, region, rating]
            );
            successCount++;
            
            if (successCount % 100 === 0) {
                console.log(`Inserted ${successCount} records...`);
            }
        }
        
        await client.query('COMMIT');
        console.log(`\n🎉 Success! Inserted all ${successCount} suburbs into the PostgreSQL database!`);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
    } finally {
        await client.end();
        console.log('Database connection closed.');
    }
}

migrate();
