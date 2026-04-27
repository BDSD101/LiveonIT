"""
join_open_data.py
Combines Melbourne suburb data from multiple sources into a single JSON file
and a flattened CSV for analysis.

Sources:
  - melbourne_suburbs_by_lga.json  — master suburb list with postcodes (Wikipedia)
  - crime_by_suburb.json           — crime incidents by suburb (CSA Victoria)
  - crime_by_lga.json              — crime rate per 100k by LGA (CSA Victoria)
  - rent_by_suburb.json            — weekly rent by suburb group (DFFH Victoria)

Output:
  melbourne_suburb_data.json       — combined suburb data keyed by suburb name
  melbourne_suburb_data.csv        — flattened version for analysis
  rent_by_suburb_ranked.json       — rent data enriched with rankings
  1brFlat_rent_by_suburb.csv       — debug CSV for 1br flat rent ranking
"""

import json
import csv
import os
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RENT_BY_SUBURB_FILE = "housing_data/rent_by_suburb.json"
RENT_BY_SUBURB_RANKED_FILE = "housing_data/rent_by_suburb_ranked.json"
MELBOURNE_SUBURBS_BY_LGA_FILE = "suburb_data/melbourne_suburbs_by_lga.json"
CRIME_BY_SUBURB_FILE = "crime_data/crime_by_suburb.json"
CRIME_BY_LGA_FILE = "crime_data/crime_by_lga.json"
OUTPUT_JSON_FILE = "melbourne_housing_crime_data.json"
OUTPUT_CSV_FILE = "melbourne_housing_crime_data.csv"

# --- Input files ---
with open(os.path.join(SCRIPT_DIR, RENT_BY_SUBURB_FILE)) as f:
    rent_data = json.load(f)
with open(os.path.join(SCRIPT_DIR, MELBOURNE_SUBURBS_BY_LGA_FILE)) as f:
    mel_suburbs_raw = json.load(f)
with open(os.path.join(SCRIPT_DIR, CRIME_BY_SUBURB_FILE)) as f:
    crime_suburb_data = json.load(f)
with open(os.path.join(SCRIPT_DIR, CRIME_BY_LGA_FILE)) as f:
    crime_lga_data = json.load(f)

# =============================================================================
# STEP 1 — Build lookups from master suburb list (Wikipedia)
# =============================================================================

wiki_suburb_lookup = {}
wiki_postcode_lookup = {}

for lga, suburbs in mel_suburbs_raw.items():
    for s in suburbs:
        name = s["suburb"].lower()
        postcode = s["postcode"]
        wiki_suburb_lookup[name] = {"suburb": s["suburb"], "postcode": postcode, "lga": lga}
        wiki_postcode_lookup[(name, postcode)] = lga

print(f"Master suburb list: {len(wiki_suburb_lookup)} suburbs across {len(mel_suburbs_raw)} LGAs")

# =============================================================================
# STEP 2 — Process crime suburb data
# Merge duplicates: sum incidents, keep topFiveOffenceProportion from highest-incident entry
# =============================================================================

crime_by_suburb_merged = {}

for entry in crime_suburb_data:
    suburb_lower = entry["suburb"].lower()
    if suburb_lower not in wiki_suburb_lookup:
        continue

    incidents = entry["totalIncidents"]

    if suburb_lower not in crime_by_suburb_merged:
        crime_by_suburb_merged[suburb_lower] = {
            "totalIncidents": 0,
            "topFiveOffenceProportion": None,
            "topIncidents": 0,
            "year": entry["year"],
        }

    crime_by_suburb_merged[suburb_lower]["totalIncidents"] += incidents

    if incidents > crime_by_suburb_merged[suburb_lower]["topIncidents"]:
        crime_by_suburb_merged[suburb_lower]["topIncidents"] = incidents
        crime_by_suburb_merged[suburb_lower]["topFiveOffenceProportion"] = entry.get("topFiveOffenceProportion")

for entry in crime_by_suburb_merged.values():
    del entry["topIncidents"]

print(f"Crime suburb entries (Melbourne): {len(crime_by_suburb_merged)}")

# =============================================================================
# STEP 3 — Process crime LGA data
# =============================================================================

def normalise_lga(name: str) -> str:
    """
    Normalise LGA names by lowercasing and removing common prefixes.
    Args:
        - name (str): Original LGA name (e.g. "City of Melbourne", "Shire of Yarra Ranges")
    Returns:
        - str: The normalised LGA name.
    """
    return name.lower().replace("city of ", "").replace("shire of ", "").strip()

crime_lga_lookup = {normalise_lga(k): v for k, v in crime_lga_data.items()}
print(f"Crime LGA entries: {len(crime_lga_lookup)}")

# =============================================================================
# STEP 4 — Process rent data with dense ranking per category
# =============================================================================

melbourne_suburb_set = set(wiki_suburb_lookup.keys())
melbourne_rent_entries = [
    entry for entry in rent_data
    if any(s.lower() in melbourne_suburb_set for s in entry["suburbs"])
]
print(f"Melbourne rent entries: {len(melbourne_rent_entries)}")

CATEGORIES = sorted({cat for entry in rent_data for cat in entry.get("weeklyRent", {}).keys()})

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
ranked_path = os.path.join(SCRIPT_DIR, RENT_BY_SUBURB_RANKED_FILE)
with open(ranked_path, "w") as f:
    json.dump(rent_data, f, indent=2, ensure_ascii=False)
print(f"Saved: {ranked_path}")

# =============================================================================
# STEP 5 — Combine all data
# Top-level key is suburb name — not repeated inside entry
# =============================================================================

combined = {}
stats = defaultdict(int)

for suburb_lower, wiki_info in wiki_suburb_lookup.items():
    suburb = wiki_info["suburb"]
    postcode = wiki_info["postcode"]
    lga = wiki_info["lga"]
    lga_norm = normalise_lga(lga)

    # Crime suburb
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

    # Crime LGA
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

    # Rent
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

    # suburb is the top-level key — not repeated inside
    combined[suburb] = {
        "postcode": postcode,
        "lga": lga,
        "crimeSuburb": crime_suburb_out,
        "crimeLga": crime_lga_out,
        "rent": rent_out,
    }

# Save combined JSON
json_path = os.path.join(SCRIPT_DIR, OUTPUT_JSON_FILE)
with open(json_path, "w") as f:
    json.dump(combined, f, indent=2, ensure_ascii=False)

print(f"\nSaved: {json_path} ({len(combined)} suburbs)")
print(f"  Crime suburb:  {stats['crime_found']} found, {stats['crime_missing']} missing")
print(f"  Crime LGA:     {stats['lga_found']} found, {stats['lga_missing']} missing")
print(f"  Rent:          {stats['rent_found']} found, {stats['rent_missing']} missing")

# =============================================================================
# STEP 6 — Flattened CSV for analysis
# =============================================================================

RENT_CATS = ["1brFlat", "2brFlat", "3brFlat", "2brHouse", "3brHouse", "4brHouse", "all"]

fieldnames = (
    ["suburb", "postcode", "lga"]
    + ["crime_totalIncidents", "crime_year"]
    + ["crime_offence1", "crime_offence1_proportion",
       "crime_offence2", "crime_offence2_proportion",
       "crime_offence3", "crime_offence3_proportion",
       "crime_offence4", "crime_offence4_proportion",
       "crime_offence5", "crime_offence5_proportion"]
    + ["crimeLga_ratePer100k", "crimeLga_melbourneRank", "crimeLga_melbourneRankPercentile"]
    + ["rent_region", "rent_period"]
    + [f"rent_{cat}" for cat in RENT_CATS]
    + [f"rent_{cat}_rank" for cat in RENT_CATS]
    + [f"rent_{cat}_percentile" for cat in RENT_CATS]
)

csv_rows = []
for suburb, data in sorted(combined.items()):
    row = {
        "suburb": suburb,
        "postcode": data["postcode"],
        "lga": data["lga"],
    }

    # Crime suburb
    cs = data.get("crimeSuburb") or {}
    row["crime_totalIncidents"] = cs.get("totalIncidents", "")
    row["crime_year"] = cs.get("year", "")

    # Top 5 offences
    top5 = list((cs.get("topFiveOffenceProportion") or {}).items())
    for i in range(1, 6):
        if i <= len(top5):
            row[f"crime_offence{i}"] = top5[i-1][0]
            row[f"crime_offence{i}_proportion"] = top5[i-1][1]
        else:
            row[f"crime_offence{i}"] = ""
            row[f"crime_offence{i}_proportion"] = ""

    # Crime LGA
    cl = data.get("crimeLga") or {}
    row["crimeLga_ratePer100k"] = cl.get("ratePer100k", "")
    row["crimeLga_melbourneRank"] = cl.get("melbourneRank", "")
    row["crimeLga_melbourneRankPercentile"] = cl.get("melbourneRankPercentile", "")

    # Rent
    r = data.get("rent") or {}
    row["rent_region"] = r.get("region", "")
    row["rent_period"] = r.get("period", "")
    weekly = r.get("weeklyRent") or {}
    ranks = r.get("weeklyRentRank") or {}
    percentiles = r.get("weeklyRentPercentile") or {}
    for cat in RENT_CATS:
        row[f"rent_{cat}"] = weekly.get(cat, "")
        row[f"rent_{cat}_rank"] = ranks.get(cat, "")
        row[f"rent_{cat}_percentile"] = percentiles.get(cat, "")

    csv_rows.append(row)

csv_path = os.path.join(SCRIPT_DIR, OUTPUT_CSV_FILE)
with open(csv_path, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(csv_rows)

print(f"Saved: {csv_path} ({len(csv_rows)} suburbs, {len(fieldnames)} columns)")

# =============================================================================
# STEP 7 — Debug CSV for 1brFlat rent ranking
# =============================================================================

# CAT = "1brFlat"
# debug_rows = []
# for entry in melbourne_rent_entries:
#     rent = entry.get("weeklyRent", {}).get(CAT)
#     if rent is None:
#         continue
#     debug_rows.append({
#         "suburbs": ", ".join(entry["suburbs"]),
#         "region": entry.get("region", ""),
#         "weeklyRent": rent,
#         "weeklyRentRank": entry.get("weeklyRentRank", {}).get(CAT),
#         "weeklyRentPercentile": entry.get("weeklyRentPercentile", {}).get(CAT),
#     })

# debug_rows.sort(key=lambda x: x["weeklyRent"], reverse=True)

# debug_csv_path = os.path.join(SCRIPT_DIR, "1brFlat_rent_by_suburb.csv")
# with open(debug_csv_path, "w", newline="") as f:
#     writer = csv.DictWriter(f, fieldnames=["suburbs", "region", "weeklyRent", "weeklyRentRank", "weeklyRentPercentile"])
#     writer.writeheader()
#     writer.writerows(debug_rows)

# print(f"Saved debug CSV: {debug_csv_path} ({len(debug_rows)} regions)")

# # Sample output
# print("\nSample entries:")
# for suburb in ["Burwood", "Carlton", "Dandenong", "Docklands"]:
#     data = combined.get(suburb)
#     if data:
#         cl = data.get("crimeLga") or {}
#         r = data.get("rent") or {}
#         weekly = r.get("weeklyRent") or {}
#         ranks = r.get("weeklyRentRank") or {}
#         print(f"  {suburb} ({data['postcode']}) — {data['lga']}")
#         print(f"    crime rate/100k: {cl.get('ratePer100k')} rank={cl.get('melbourneRank')}")
#         print(f"    rent (all): ${weekly.get('all')} rank={ranks.get('all')}")
