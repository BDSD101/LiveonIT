-- Find cafes within 1500 meters of a coordinate in Abbotsford
SELECT 
    name, 
    ST_Distance(way, ST_Transform(ST_SetSRID(ST_MakePoint(144.998, -37.804), 4326), 3857)) as distance_meters
FROM planet_osm_point
WHERE amenity = 'cafe'
AND ST_DWithin(
    way, 
    ST_Transform(ST_SetSRID(ST_MakePoint(144.998, -37.804), 4326), 3857), 
    800 -- Distance in meters
)
ORDER BY distance_meters ASC
LIMIT 10;