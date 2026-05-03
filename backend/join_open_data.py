"""
join_open_data.py
Combines Melbourne suburb data from multiple sources into a single JSON file
and a flattened CSV for analysis.

Sources:
  - melbourne_suburbs_by_lga.json      — master suburb list with postcodes (Wikipedia)
  - crime_by_suburb.json               — crime incidents by suburb (CSA Victoria)
  - crime_by_lga.json                  — crime rate per 100k by LGA (CSA Victoria)
  - rent_by_suburb.json                — weekly rent by suburb group (DFFH Victoria)
  - house_unit_prices_by_suburb.json   — median house and unit sale prices (Land Vic)

Output:
  melbourne_suburb_data.json       — combined suburb data keyed by suburb name
  melbourne_suburb_data.csv        — flattened version for analysis
  rent_by_suburb_ranked.json       — rent data enriched with rankings
  1brFlat_rent_by_suburb.csv       — debug CSV for 1br flat rent ranking
"""

import json
import csv
import os
import math
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RENT_BY_SUBURB_FILE = "housing_data/rent_by_suburb.json"
RENT_BY_SUBURB_RANKED_FILE = "housing_data/rent_by_suburb_ranked.json"
HOUSE_UNIT_PRICES_FILE = "housing_data/house_unit_prices_by_suburb.json"
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
with open(os.path.join(SCRIPT_DIR, HOUSE_UNIT_PRICES_FILE)) as f:
    house_unit_data = json.load(f)

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
# STEP 2 — Build house/unit price lookup
# =============================================================================

house_price_lookup = {
    entry["suburb"].lower(): {
        "meanMedianHousePrice": entry.get("meanMedianHousePrice"),
        "meanMedianUnitPrice":  entry.get("meanMedianUnitPrice"),
    }
    for entry in house_unit_data
    if entry.get("suburb")
}
print(f"House/unit price entries: {len(house_price_lookup)}")

# =============================================================================
# STEP 3 — Process crime suburb data
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
# STEP 4 — Process crime LGA data
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
# STEP 5 — Process rent data with dense ranking per category
# =============================================================================

melbourne_suburb_set = set(wiki_suburb_lookup.keys())
melbourne_rent_entries = [
    entry for entry in rent_data
    if any(s.lower() in melbourne_suburb_set for s in entry["suburbs"])
]
print(f"Melbourne rent entries: {len(melbourne_rent_entries)}")

CATEGORIES = sorted({cat for entry in rent_data for cat in entry.get("weeklyRent", {}).keys()})

## REPLACED BY THE MAD SCORES
# for cat in CATEGORIES:
#     entries_with_value = [
#         e for e in melbourne_rent_entries
#         if e.get("weeklyRent", {}).get(cat) is not None
#     ]
#     sorted_entries = sorted(entries_with_value,
#                             key=lambda e: e["weeklyRent"][cat],
#                             reverse=True)
#     total = len(sorted_entries)

#     for e in entries_with_value:
#         if "weeklyRentRank" not in e:
#             e["weeklyRentRank"] = {}
#             e["weeklyRentPercentile"] = {}

#     rank = 1
#     for i, entry in enumerate(sorted_entries):
#         if i > 0 and entry["weeklyRent"][cat] == sorted_entries[i - 1]["weeklyRent"][cat]:
#             entry["weeklyRentRank"][cat] = sorted_entries[i - 1]["weeklyRentRank"][cat]
#             entry["weeklyRentPercentile"][cat] = sorted_entries[i - 1]["weeklyRentPercentile"][cat]
#         else:
#             rank = 1 if i == 0 else rank + 1
#             entry["weeklyRentRank"][cat] = rank
#             entry["weeklyRentPercentile"][cat] = round((1 - (rank - 1) / total) * 100, 1)

# Build reverse lookup: suburb_lower → rent entry
rent_lookup = {}
for entry in melbourne_rent_entries:
    for suburb in entry["suburbs"]:
        rent_lookup[suburb.lower()] = entry

## REPLACED BY THE MAD SCORES
# Save enriched rent JSON
# ranked_path = os.path.join(SCRIPT_DIR, RENT_BY_SUBURB_RANKED_FILE)
# with open(ranked_path, "w") as f:
#     json.dump(rent_data, f, indent=2, ensure_ascii=False)
# print(f"Saved: {ranked_path}")

# =============================================================================
# STEP 6 — Combine all data
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
            # "melbourneRank": crime_lga["melbourneRank"],
            # "melbourneRankPercentile": crime_lga["melbourneRankPercentile"],
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
            # "weeklyRentRank": rent_entry.get("weeklyRentRank"),
            # "weeklyRentPercentile": rent_entry.get("weeklyRentPercentile"),
            "region": rent_entry.get("region"),
            "period": rent_entry.get("period"),
        }
    else:
        stats["rent_missing"] += 1
        rent_out = None

    # House/unit prices
    house_prices = house_price_lookup.get(suburb_lower)
    if house_prices:
        stats["house_found"] += 1
    else:
        stats["house_missing"] += 1

    # suburb is the top-level key — not repeated inside
    combined[suburb] = {
        "postcode": postcode,
        "lga": lga,
        "crimeSuburb": crime_suburb_out,
        "crimeLga": crime_lga_out,
        "rent": rent_out,
        "housePrices": house_prices,
    }

# Save combined JSON
json_path = os.path.join(SCRIPT_DIR, OUTPUT_JSON_FILE)
with open(json_path, "w") as f:
    json.dump(combined, f, indent=2, ensure_ascii=False)

print(f"\nSaved: {json_path} ({len(combined)} suburbs)")
print(f"  Crime suburb:  {stats['crime_found']} found, {stats['crime_missing']} missing")
print(f"  Crime LGA:     {stats['lga_found']} found, {stats['lga_missing']} missing")
print(f"  Rent:          {stats['rent_found']} found, {stats['rent_missing']} missing")
print(f"  House prices:  {stats['house_found']} found, {stats['house_missing']} missing")

# =============================================================================
# STEP 7 — Robust z-scores (MAD) for house prices, rent, and crime
# All scores computed only over Greater Melbourne suburbs (wiki_suburb_lookup).
# Formula: (value - median) / MAD  where MAD = median absolute deviation
# Crime score is negated so that safer = higher score.
# Result is clamped to [-3, 3] to limit the effect of extreme outliers.
# =============================================================================

def mad_scores(values: list[float], invert: bool = False) -> list[float | None]:
    """
    Compute robust z-scores using median and MAD for a list of values.
    None entries in the input are preserved as None in the output.
    Args:
        - values: list of floats (with None for missing)
        - invert: if True, negate the score (use for crime: lower = safer = higher score)
    Returns:
        - list of robust z-scores (None where input was None), clamped to [-3, 3]
    """
    valid = [v for v in values if v is not None]
    if len(valid) < 2:
        return [None] * len(values)

    median = sorted(valid)[len(valid) // 2]
    mad = sorted(abs(v - median) for v in valid)[len(valid) // 2]

    if mad == 0:
        return [None] * len(values)

    results = []
    for v in values:
        if v is None:
            results.append(None)
        else:
            score = (v - median) / mad
            if invert:
                score = -score
            results.append(max(-3.0, min(3.0, round(score, 4))))
    return results


print("\nComputing robust z-scores (MAD)...")

suburb_keys = list(combined.keys())

# --- House prices ---
house_vals = [combined[s]["housePrices"].get("meanMedianHousePrice") if combined[s]["housePrices"] else None for s in suburb_keys]
unit_vals  = [combined[s]["housePrices"].get("meanMedianUnitPrice")  if combined[s]["housePrices"] else None for s in suburb_keys]
house_scores = mad_scores(house_vals)
unit_scores  = mad_scores(unit_vals)

for i, suburb in enumerate(suburb_keys):
    if combined[suburb]["housePrices"] is None:
        combined[suburb]["housePrices"] = {}
    combined[suburb]["housePrices"]["housePriceScore"] = house_scores[i]
    combined[suburb]["housePrices"]["unitPriceScore"]  = unit_scores[i]

# --- Rent (per category) ---
for cat in CATEGORIES:
    cat_vals = []
    for s in suburb_keys:
        rent = combined[s].get("rent")
        cat_vals.append(rent["weeklyRent"].get(cat) if rent and rent.get("weeklyRent") else None)
    cat_scores = mad_scores(cat_vals)
    for i, suburb in enumerate(suburb_keys):
        if combined[suburb].get("rent") is None:
            continue
        if "rentScore" not in combined[suburb]["rent"]:
            combined[suburb]["rent"]["rentScore"] = {}
        combined[suburb]["rent"]["rentScore"][cat] = cat_scores[i]

# --- Crime (LGA rate per 100k, inverted so safer = higher score) ---
crime_vals = [combined[s]["crimeLga"]["ratePer100k"] if combined[s].get("crimeLga") else None for s in suburb_keys]
crime_scores = mad_scores(crime_vals, invert=True)

for i, suburb in enumerate(suburb_keys):
    if combined[suburb].get("crimeLga") is None:
        continue
    combined[suburb]["crimeLga"]["crimeScore"] = crime_scores[i]

scored = sum(1 for s in crime_scores if s is not None)
print(f"  Crime scores:      {scored} suburbs scored")
scored = sum(1 for s in house_scores if s is not None)
print(f"  House price scores: {scored} suburbs scored")
scored = sum(1 for s in unit_scores if s is not None)
print(f"  Unit price scores:  {scored} suburbs scored")

# Re-save combined JSON with scores added
with open(json_path, "w") as f:
    json.dump(combined, f, indent=2, ensure_ascii=False)
print(f"  Re-saved: {json_path} (with scores)")

# =============================================================================
# STEP 8 — Flattened CSV for analysis
# =============================================================================

RENT_CATS = ["1brFlat", "2brFlat", "3brFlat", "2brHouse", "3brHouse", "4brHouse", "all"]

fieldnames = (
    ["suburb", "postcode", "lga"]
    + ["crime_totalIncidents", "crime_year"]
    # + ["crime_offence1", "crime_offence1_proportion",
    #    "crime_offence2", "crime_offence2_proportion",
    #    "crime_offence3", "crime_offence3_proportion",
    #    "crime_offence4", "crime_offence4_proportion",
    #    "crime_offence5", "crime_offence5_proportion"]
    + ["crimeLga_ratePer100k", 
    #    "crimeLga_melbourneRank", 
    #    "crimeLga_melbourneRankPercentile", 
       "crimeLga_crimeScore"]
    + ["rent_region", "rent_period"]
    + [f"rent_{cat}" for cat in RENT_CATS]
    # + [f"rent_{cat}_rank" for cat in RENT_CATS]
    # + [f"rent_{cat}_percentile" for cat in RENT_CATS]
    + [f"rent_{cat}_score" for cat in RENT_CATS]
    + ["meanMedianHousePrice", "meanMedianUnitPrice", "housePriceScore", "unitPriceScore"]
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
    # top5 = list((cs.get("topFiveOffenceProportion") or {}).items())
    # for i in range(1, 6):
    #     if i <= len(top5):
    #         row[f"crime_offence{i}"] = top5[i-1][0]
    #         row[f"crime_offence{i}_proportion"] = top5[i-1][1]
    #     else:
    #         row[f"crime_offence{i}"] = ""
    #         row[f"crime_offence{i}_proportion"] = ""

    # Crime LGA
    cl = data.get("crimeLga") or {}
    row["crimeLga_ratePer100k"] = cl.get("ratePer100k", "")
    row["crimeLga_crimeScore"] = cl.get("crimeScore", "")
    # row["crimeLga_melbourneRank"] = cl.get("melbourneRank", "")
    # row["crimeLga_melbourneRankPercentile"] = cl.get("melbourneRankPercentile", "")

    # Rent
    r = data.get("rent") or {}
    row["rent_region"] = r.get("region", "")
    row["rent_period"] = r.get("period", "")
    weekly = r.get("weeklyRent") or {}
    ranks = r.get("weeklyRentRank") or {}
    percentiles = r.get("weeklyRentPercentile") or {}
    for cat in RENT_CATS:
        row[f"rent_{cat}"] = weekly.get(cat, "")
        row[f"rent_{cat}_score"] = (r.get("rentScore") or {}).get(cat, "")
        # row[f"rent_{cat}_rank"] = ranks.get(cat, "")
        # row[f"rent_{cat}_percentile"] = percentiles.get(cat, "")

    # House/unit prices
    hp = data.get("housePrices") or {}
    row["meanMedianHousePrice"] = hp.get("meanMedianHousePrice", "")
    row["meanMedianUnitPrice"]  = hp.get("meanMedianUnitPrice", "")
    row["housePriceScore"]      = hp.get("housePriceScore", "")
    row["unitPriceScore"]       = hp.get("unitPriceScore", "")

    csv_rows.append(row)

csv_path = os.path.join(SCRIPT_DIR, OUTPUT_CSV_FILE)
with open(csv_path, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(csv_rows)

print(f"Saved: {csv_path} ({len(csv_rows)} suburbs, {len(fieldnames)} columns)")

# =============================================================================
# STEP 9 — Debug CSV for 1brFlat rent ranking
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
