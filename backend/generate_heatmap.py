import folium
from folium.plugins import HeatMap
import pandas as pd
import pgeocode

# 1. Load original data to extract postcodes for Geocoding
orig_df = pd.read_csv('backend/melbourne_housing_crime_data.csv')

# There can be multiple entries for the same suburb, dropping duplicates
postcode_map = orig_df.drop_duplicates(subset=['suburb']).set_index('suburb')['postcode'].to_dict()

# 2. Load our generated ratings data
df = pd.read_csv('backend/suburb_regions_ratings.csv')

# 3. Add lat/lon using pgeocode (offline, fast postal code geocoder)
print("Geocoding suburbs...")
nom = pgeocode.Nominatim('au')

def get_lat_lon(row):
    postcode = postcode_map.get(row['Suburb'])
    if pd.isna(postcode):
        return pd.Series({'lat': None, 'lon': None})
    # pgeocode needs postcode as string
    res = nom.query_postal_code(str(int(postcode)))
    return pd.Series({'lat': res.latitude, 'lon': res.longitude})

df[['lat', 'lon']] = df.apply(get_lat_lon, axis=1)

# Drop any suburbs where pgeocode couldn't find coordinates
df = df.dropna(subset=['lat', 'lon'])

print(f"Successfully geocoded {len(df)} suburbs.")

# 4. Normalize intensity (from user provided snippet)
df['intensity'] = (df['Rating'] - df['Rating'].min()) / (df['Rating'].max() - df['Rating'].min())
df['intensity'] = df['intensity'].fillna(1.0).replace(0, 0.1)

# 5. Set up unique color gradients for our actual Regions
region_gradients = {
    'Inner Metro': {
        0.2: '#4575b4', 0.5: '#91bfdb', 0.8: '#fee090', 1.0: '#d73027'  
    },
    'Inner South East': {
        0.2: '#313695', 0.5: '#74add1', 0.8: '#f46d43', 1.0: '#a50026'
    },
    'Western': {
        0.2: '#00441b', 0.5: '#5aae61', 0.8: '#f7fcf5', 1.0: '#ffff33'
    },
    'Northern': {
        0.2: '#40004b', 0.5: '#9970ab', 0.8: '#d2b4de', 1.0: '#1b7837'
    },
    'Eastern': {
        0.2: '#3f007d', 0.5: '#807dba', 0.8: '#efedf5', 1.0: '#f768a1'
    },
    'Southern': {
        0.2: '#08306b', 0.5: '#2171b5', 0.8: '#6baed6', 1.0: '#ff7f00'
    }
}

default_gradient = {0.4: 'orange', 1.0: 'red'}

# 6. Initialize the map
m = folium.Map(location=[-37.8136, 144.9631], zoom_start=10, tiles="CartoDB positron")

# 7. Programmatically loop through each unique Region
for region_name, region_df in df.groupby('Region'):
    heat_data = region_df[['lat', 'lon', 'intensity']].values.tolist()
    gradient = region_gradients.get(region_name, default_gradient)
    
    layer = folium.FeatureGroup(name=f"Region: {region_name}")
    
    HeatMap(
        data=heat_data,
        gradient=gradient,
        min_opacity=0.4,
        max_val=1.0,
        radius=30,
        blur=18
    ).add_to(layer)
    
    layer.add_to(m)

# 8. Add layer control
folium.LayerControl(collapsed=False).add_to(m)

# Save to the frontend directory so it's accessible
output_file = "frontend/melbourne_csv_heatmap.html"
m.save(output_file)
print(f"Map built directly from CSV data structure and saved to {output_file}!")
