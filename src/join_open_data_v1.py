"""
join_open_data.py
Combines Melbourne suburb data from multiple sources into a single JSON file:
  - melbourne_suburbs_by_lga.json  — master suburb list with postcodes (from Wikipedia)
  - crime_by_suburb.json           — crime incidents by suburb (from CSA Victoria)
  - crime_by_lga.json              — crime rate per 100k by LGA (from CSA Victoria)
  - rent_by_suburb.json            — weekly rent by suburb group (from DFFH Victoria)

Output:
  melbourne_suburb_data.json       — combined suburb data for liveability scoring
  1brFlat_rent_by_suburb.csv       — debug CSV for 1br flat rent ranking
"""

import json
import csv
import os
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Input files ---
with open(os.path.join(SCRIPT_DIR, "housing_data/rent_by_suburb.json")) as f:
    rent_data = json.load(f)
with open(os.path.join(SCRIPT_DIR, "suburb_data/melbourne_suburbs_by_lga.json")) as f:
    mel_suburbs_raw = json.load(f)
with open(os.path.join(SCRIPT_DIR, "crime_data/crime_by_suburb.json")) as f:
    crime_suburb_data = json.load(f)
with open(os.path.join(SCRIPT_DIR, "crime_data/crime_by_lga.json")) as f:
    crime_lga_data = json.load(f)

# =============================================================================
# STEP 1 — Build lookups from master suburb list (Wikipedia)
# =============================================================================

# suburb_lower → {postcode, lga}
wiki_suburb_lookup = {}
# (suburb_lower, postcode) → lga
wiki_postcode_lookup = {}
# suburb_lower → set of LGAs (for shared suburbs)
suburb_lgas = defaultdict(set)

for lga, suburbs in mel_suburbs_raw.items():
    for s in suburbs:
        name = s["suburb"].lower()
        postcode = s["postcode"]
        wiki_suburb_lookup[name] = {"suburb": s["suburb"], "postcode": postcode, "lga": lga}
        wiki_postcode_lookup[(name, postcode)] = lga
        suburb_lgas[name].add(lga)

print(f"Master suburb list: {len(wiki_suburb_lookup)} suburbs across {len(mel_suburbs_raw)} LGAs")

# =============================================================================
# STEP 2 — Process crime suburb data
# Merge duplicates: sum incidents, keep topFiveOffenceProportion from highest-incident entry
# Use Wikipedia postcode as authoritative — flag mismatches
# =============================================================================

# suburb_lower → merged crime entry
crime_by_suburb_merged = {}

for entry in crime_suburb_data:
    suburb_lower = entry["suburb"].lower()

    # Only process Melbourne suburbs
    if suburb_lower not in wiki_suburb_lookup:
        continue

    wiki_info = wiki_suburb_lookup[suburb_lower]
    wiki_postcode = wiki_info["postcode"]
    crime_postcode = entry["postcode"]
    incidents = entry["totalIncidents"]

    if suburb_lower not in crime_by_suburb_merged:
        crime_by_suburb_merged[suburb_lower] = {
            "totalIncidents": 0,
            "topFiveOffenceProportion": None,
            "topIncidents": 0,
            "crimePostcode": crime_postcode,
            "postcodeMatch": crime_postcode == wiki_postcode,
            "year": entry["year"],
        }

    crime_by_suburb_merged[suburb_lower]["totalIncidents"] += incidents

    # Keep topFiveOffenceProportion from the highest-incident entry
    if incidents > crime_by_suburb_merged[suburb_lower]["topIncidents"]:
        crime_by_suburb_merged[suburb_lower]["topIncidents"] = incidents
        crime_by_suburb_merged[suburb_lower]["topFiveOffenceProportion"] = entry.get("topFiveOffenceProportion")
        crime_by_suburb_merged[suburb_lower]["crimePostcode"] = crime_postcode
        crime_by_suburb_merged[suburb_lower]["postcodeMatch"] = crime_postcode == wiki_postcode

# Remove internal tracking field
for entry in crime_by_suburb_merged.values():
    del entry["topIncidents"]
    del entry["crimePostcode"]
    del entry["postcodeMatch"]

print(f"Crime suburb entries (Melbourne): {len(crime_by_suburb_merged)}")

# =============================================================================
# STEP 3 — Process crime LGA data
# Build lookup normalising LGA names
# =============================================================================

def normalise_lga(name):
    """Normalise LGA name for lookup — strip City of / Shire of, lowercase."""
    return name.lower().replace("city of ", "").replace("shire of ", "").strip()

crime_lga_lookup = {normalise_lga(k): v for k, v in crime_lga_data.items()}

print(f"Crime LGA entries: {len(crime_lga_lookup)}")

# =============================================================================
# STEP 4 — Process rent data
# Build reverse lookup: suburb_lower → rent entry
# Rank each category across Melbourne suburbs (dense ranking, tied = same rank)
# =============================================================================

melbourne_suburb_set = set(wiki_suburb_lookup.keys())

# Filter rent entries to those with at least one Melbourne suburb
melbourne_rent_entries = [
    entry for entry in rent_data
    if any(s.lower() in melbourne_suburb_set for s in entry["suburbs"])
]
print(f"Melbourne rent entries: {len(melbourne_rent_entries)}")

# Get all rent categories
CATEGORIES = sorted({cat for entry in rent_data for cat in entry.get("weeklyRent", {}).keys()})

# Rank each category with dense ranking
for cat in CATEGORIES:
    entries_with_value = [
        e for e in melbourne_rent_entries
        if e.get("weeklyRent", {}).get(cat) is not None
    ]
    sorted_entries = sorted(entries_with_value,
                            key=lambda e: e["weeklyRent"][cat],
                            reverse=True)
    total = len(sorted_entries)

    for e in entries_with_value:
        if "weeklyRentRank" not in e:
            e["weeklyRentRank"] = {}
            e["weeklyRentPercentile"] = {}

    rank = 1
    for i, entry in enumerate(sorted_entries):
        if i > 0 and entry["weeklyRent"][cat] == sorted_entries[i - 1]["weeklyRent"][cat]:
            entry["weeklyRentRank"][cat] = sorted_entries[i - 1]["weeklyRentRank"][cat]
            entry["weeklyRentPercentile"][cat] = sorted_entries[i - 1]["weeklyRentPercentile"][cat]
        else:
            rank = 1 if i == 0 else rank + 1
            entry["weeklyRentRank"][cat] = rank
            entry["weeklyRentPercentile"][cat] = round((1 - (rank - 1) / total) * 100, 1)

# Build reverse lookup: suburb_lower → rent entry
rent_lookup = {}
for entry in melbourne_rent_entries:
    for suburb in entry["suburbs"]:
        rent_lookup[suburb.lower()] = entry

# Save enriched rent JSON
ranked_path = os.path.join(SCRIPT_DIR, "housing_data/rent_by_suburb_ranked.json")
with open(ranked_path, "w") as f:
    json.dump(rent_data, f, indent=2, ensure_ascii=False)
print(f"Saved: {ranked_path}")

# =============================================================================
# STEP 5 — Combine all data into one entry per suburb
# =============================================================================

combined = {}
stats = {"crime_found": 0, "crime_missing": 0, "lga_found": 0, "lga_missing": 0,
         "rent_found": 0, "rent_missing": 0}

for suburb_lower, wiki_info in wiki_suburb_lookup.items():
    suburb = wiki_info["suburb"]
    postcode = wiki_info["postcode"]
    lga = wiki_info["lga"]
    lga_norm = normalise_lga(lga)

    # Crime suburb data
    crime_suburb = crime_by_suburb_merged.get(suburb_lower)
    if crime_suburb:
        stats["crime_found"] += 1
        crime_suburb_out = {
            "totalIncidents": crime_suburb["totalIncidents"],
            "topFiveOffenceProportion": crime_suburb.get("topFiveOffenceProportion"),
            "year": crime_suburb["year"],
        }
    else:
        stats["crime_missing"] += 1
        crime_suburb_out = None

    # Crime LGA data — use Wikipedia LGA
    crime_lga = crime_lga_lookup.get(lga_norm)
    if crime_lga:
        stats["lga_found"] += 1
        crime_lga_out = {
            "ratePer100k": crime_lga["ratePer100k"],
            "melbourneRank": crime_lga["melbourneRank"],
            "melbourneRankPercentile": crime_lga["melbourneRankPercentile"],
            "year": crime_lga["year"],
        }
    else:
        stats["lga_missing"] += 1
        crime_lga_out = None

    # Rent data
    rent_entry = rent_lookup.get(suburb_lower)
    if rent_entry:
        stats["rent_found"] += 1
        rent_out = {
            "weeklyRent": rent_entry.get("weeklyRent"),
            "weeklyRentRank": rent_entry.get("weeklyRentRank"),
            "weeklyRentPercentile": rent_entry.get("weeklyRentPercentile"),
            "region": rent_entry.get("region"),
            "period": rent_entry.get("period"),
        }
    else:
        stats["rent_missing"] += 1
        rent_out = None

    combined[suburb] = {
        "suburb": suburb,
        "postcode": postcode,
        "lga": lga,
        "crimeSuburb": crime_suburb_out,
        "crimeLga": crime_lga_out,
        "rent": rent_out,
    }

# =============================================================================
# STEP 6 — Save combined output
# =============================================================================

output_path = os.path.join(SCRIPT_DIR, "suburb_data/melbourne_suburb_data.json")
with open(output_path, "w") as f:
    json.dump(combined, f, indent=2, ensure_ascii=False)

print(f"\nSaved: {output_path} ({len(combined)} suburbs)")
print(f"\nJoin statistics:")
print(f"  Crime suburb:  {stats['crime_found']} found, {stats['crime_missing']} missing")
print(f"  Crime LGA:     {stats['lga_found']} found, {stats['lga_missing']} missing")
print(f"  Rent:          {stats['rent_found']} found, {stats['rent_missing']} missing")

# =============================================================================
# STEP 7 — Debug CSV for 1brFlat rent ranking
# =============================================================================

CAT = "1brFlat"
rows = []
for entry in melbourne_rent_entries:
    rent = entry.get("weeklyRent", {}).get(CAT)
    if rent is None:
        continue
    rows.append({
        "suburbs": ", ".join(entry["suburbs"]),
        "region": entry.get("region", ""),
        "weeklyRent": rent,
        "weeklyRentRank": entry.get("weeklyRentRank", {}).get(CAT),
        "weeklyRentPercentile": entry.get("weeklyRentPercentile", {}).get(CAT),
    })

rows.sort(key=lambda x: x["weeklyRent"], reverse=True)

csv_path = os.path.join(SCRIPT_DIR, "suburb_data/1brFlat_rent_by_suburb.csv")
with open(csv_path, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["suburbs", "region", "weeklyRent", "weeklyRentRank", "weeklyRentPercentile"])
    writer.writeheader()
    writer.writerows(rows)

print(f"\nSaved debug CSV: {csv_path} ({len(rows)} regions)")

# Print sample output
print("\nSample combined entries:")
for suburb in ["Burwood", "Carlton", "Dandenong", "Docklands"]:
    entry = combined.get(suburb)
    if entry:
        print(f"\n  {suburb} ({entry['postcode']}) — {entry['lga']}")
        if entry["crimeSuburb"]:
            print(f"    crime incidents: {entry['crimeSuburb']['totalIncidents']}")
        if entry["crimeLga"]:
            print(f"    crime rate/100k: {entry['crimeLga']['ratePer100k']} rank={entry['crimeLga']['melbourneRank']}")
        if entry["rent"]:
            print(f"    weekly rent (all): {entry['rent']['weeklyRent'].get('all')} rank={entry['rent']['weeklyRentRank'].get('all') if entry['rent']['weeklyRentRank'] else None}")
