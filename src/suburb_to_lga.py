import urllib.request
import json
import os

API = "https://en.wikipedia.org/w/api.php"
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 
                      "housing_data", "melbourne_suburbs_by_lga.json")
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

def api_get(params):
    params["format"] = "json"
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{API}?{query}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "LiveOnIT/1.0 (student project; contact@example.com) Python/3"
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

import urllib.parse

# Step 1 — get all LGA subcategories
print("Fetching LGA subcategories...")
data = api_get({
    "action": "query",
    "list": "categorymembers",
    "cmtitle": "Category:Suburbs_of_Melbourne_by_local_government_area",
    "cmtype": "subcat",
    "cmlimit": "500",
})

subcategories = data["query"]["categorymembers"]
print(f"  Found {len(subcategories)} LGA subcategories")

result = {}

# Step 2 — for each LGA subcategory, get all suburb pages
for subcat in subcategories:
    cat_title = subcat["title"]  # e.g. "Category:Suburbs of the City of Boroondara"
    
    # Extract LGA name from category title
    lga = cat_title.replace("Category:Suburbs of the ", "").replace("Category:Suburbs of ", "")
    print(f"  Fetching suburbs for: {lga}")
    
    suburbs = []
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": cat_title.replace(" ", "_"),
        "cmtype": "page",
        "cmlimit": "500",
    }
    
    # Handle pagination
    while True:
        data = api_get(params)
        members = data["query"]["categorymembers"]
        for m in members:
            # Strip disambiguation suffixes like ", Victoria"
            name = m["title"].replace(", Victoria", "").replace(", Melbourne", "").strip()
            suburbs.append(name)
        
        if "continue" in data:
            params["cmcontinue"] = data["continue"]["cmcontinue"]
        else:
            break
    
    result[lga] = sorted(suburbs)
    print(f"    {len(suburbs)} suburbs")

# Save
with open(OUTPUT, "w") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)

print(f"\nSaved {len(result)} LGAs with suburbs to {OUTPUT}")
print(f"Total suburbs: {sum(len(v) for v in result.values())}")