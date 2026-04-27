"""
Downloads Melbourne suburbs with postcodes and LGA from Wikipedia.
Uses the Wikipedia API — no web scraping.
Output: melbourne_suburbs_by_lga.json in the same directory as this script.
"""

import urllib.request
import urllib.parse
import json
import re
import os

API = "https://en.wikipedia.org/w/api.php"
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "suburb_data/melbourne_suburbs_by_lga.json")

def api_get(params):
    params["format"] = "json"
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{API}?{query}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "LiveOnIT/1.0 (student project) Python/3"
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

print("Fetching page wikitext...")
data = api_get({
    "action": "query",
    "titles": "List_of_Melbourne_suburbs",
    "prop": "revisions",
    "rvprop": "content",
    "rvslots": "main",
})

pages = data["query"]["pages"]
page = next(iter(pages.values()))
wikitext = page["revisions"][0]["slots"]["main"]["*"]
lines = wikitext.split("\n")
print(f"Total lines: {len(lines)}")

# LGA header pattern: ===[[City of Melbourne]]===  or  ===[[Shire of X|Shire of X]]===
# Extract just the LGA name stripping City of / Shire of
lga_pattern = re.compile(r"^===\[\[(?:[^\]|]+\|)?([^\]]+)\]\]===")

# Suburb line pattern: * [[Suburb, Victoria|Suburb Name]] 3053
# or: * [[Suburb Name]] 3053
suburb_pattern = re.compile(r"^\*\s+\[\[(?:[^\]|]+\|)?([^\]|]+)\]\]\s+(\d{4})")

result = {}
current_lga = None

for line in lines:
    # Check for LGA header
    lga_match = lga_pattern.match(line.strip())
    if lga_match:
        raw = lga_match.group(1).strip()
        # Strip "City of " / "Shire of " prefix
        current_lga = re.sub(r"^(City of |Shire of )", "", raw).strip()
        if current_lga not in result:
            result[current_lga] = []
        continue

    # Check for suburb line (must start with single * not **)
    if current_lga and line.startswith("* "):
        suburb_match = suburb_pattern.match(line)
        if suburb_match:
            suburb = suburb_match.group(1).strip()
            postcode = suburb_match.group(2).strip()
            # Skip duplicates within same LGA
            if not any(s["suburb"] == suburb for s in result[current_lga]):
                result[current_lga].append({
                    "suburb": suburb,
                    "postcode": postcode
                })

# Remove any empty or non-LGA sections
result = {k: v for k, v in result.items() if len(v) > 0}

with open(OUTPUT, "w") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)

total_suburbs = sum(len(v) for v in result.values())
print(f"Saved {len(result)} LGAs with {total_suburbs} suburbs")
print(f"Output: {OUTPUT}")

# Print summary
for lga, suburbs in sorted(result.items()):
    print(f"  {lga}: {len(suburbs)} suburbs")
