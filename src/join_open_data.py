import json
import csv

# Load files
with open("housing_data/rent_by_suburb.json") as f:
    rent_data = json.load(f)
with open("housing_data/melbourne_suburbs_by_lga.json") as f:
    mel_suburbs = json.load(f)

# Build flat set of all Melbourne suburbs (lowercase for matching)
melbourne_suburb_set = set()
for lga, suburbs in mel_suburbs.items():
    for s in suburbs:
        melbourne_suburb_set.add(s.lower())

# Get a list of categories for rent based on those used in rent_by_suburb.json.
CATEGORIES = list({cat for entry in rent_data for cat in entry.get("weeklyRent", {}).keys()})
CATEGORIES.sort()

# For each rent category collect all Melbourne entries with a value
# CATEGORIES = ["1brFlat", "2brFlat", "3brFlat", "2brHouse", "3brHouse", "4brHouse", "all"]

# Filter rent entries that have at least one Melbourne suburb
melbourne_rent_entries = [
    entry for entry in rent_data
    if any(s.lower() in melbourne_suburb_set for s in entry["suburbs"])
]

print(f"Melbourne rent entries: {len(melbourne_rent_entries)}")

for cat in CATEGORIES:
    entries_with_value = [
        e for e in melbourne_rent_entries
        if e.get("weeklyRent", {}).get(cat) is not None
    ]
    sorted_entries = sorted(entries_with_value,
                            key=lambda e: e["weeklyRent"][cat],
                            reverse=True)
    total = len(sorted_entries)

    # Initialise rank fields on every entry
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
            if i == 0:
                rank = 1
            else:
                rank += 1
            entry["weeklyRentRank"][cat] = rank
            entry["weeklyRentPercentile"][cat] = round((1 - (rank - 1) / total) * 100, 1)

# Save enriched rent data
with open("housing_data/rent_by_suburb_ranked.json", "w") as f:
    json.dump(rent_data, f, indent=2, ensure_ascii=False)

print("Done — rent_by_suburb_ranked.json")

# Generate CSV for 1brFlat — one row per region sorted by weeklyRent descending
CAT = "1brFlat"
rows = []
for entry in melbourne_rent_entries:
    rent = entry.get("weeklyRent", {}).get(CAT)
    if rent is None:
        continue
    rank = entry.get("weeklyRentRank", {}).get(CAT)
    percentile = entry.get("weeklyRentPercentile", {}).get(CAT)
    rows.append({
        "suburbs": ", ".join(entry["suburbs"]),
        "region": entry.get("region", ""),
        "weeklyRent": rent,
        "weeklyRentRank": rank,
        "weeklyRentPercentile": percentile,
    })

rows.sort(key=lambda x: x["weeklyRent"], reverse=True)

with open("housing_data/1brFlat_rent_by_suburb.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["suburbs", "region", "weeklyRent", "weeklyRentRank", "weeklyRentPercentile"])
    writer.writeheader()
    writer.writerows(rows)

print(f"Saved: 1brFlat_rent_by_suburb.csv ({len(rows)} regions)")