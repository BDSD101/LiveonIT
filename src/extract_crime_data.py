"""
Victorian Crime Statistics Extractor
Uses the Victorian Government CKAN API (discover.data.vic.gov.au) to find and download
the latest LGA Criminal Incidents Excel file from Crime Statistics Agency Victoria,
then extracts LGA and Suburb level data into JSON files.

No hardcoded URLs — the CKAN API always resolves to the latest quarterly release.

Source: https://discover.data.vic.gov.au/dataset/criminal-incident
License: Creative Commons Attribution 4.0 International
"""

import urllib.request
import urllib.error
import json
import os
import sys
import re
from datetime import datetime

try:
    import pandas as pd
except ImportError:
    print("pandas not installed. Run: pip install pandas openpyxl")
    sys.exit(1)

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crime_data")
os.makedirs(OUTPUT_DIR, exist_ok=True)

CKAN_API = "https://discover.data.vic.gov.au/api/3/action"
DATASET_ID = "criminal-incident"
EXCEL_FILE = os.path.join(OUTPUT_DIR, "crime_incidents_lga.xlsx")
OUTPUT_LGA = os.path.join(OUTPUT_DIR, "crime_by_lga.json")
OUTPUT_SUBURB = os.path.join(OUTPUT_DIR, "crime_by_suburb.json")

def get_latest_lga_file_url():
    print("Querying CKAN API for latest dataset resources...")
    url = f"{CKAN_API}/package_show?id={DATASET_ID}"

    with urllib.request.urlopen(url) as response:
        data = json.loads(response.read())

    if not data.get("success"):
        raise Exception(f"CKAN API error: {data.get('error')}")

    resources = data["result"]["resources"]
    print(f"  Found {len(resources)} resources")

    # Filter to LGA files on files.crimestatistics.vic.gov.au with a period_end date
    lga_resources = [
        r for r in resources
        if "lga" in r["name"].lower()
        and r.get("period_end")
        and r["url"].startswith("https://files.crimestatistics.vic.gov.au")
    ]

    if not lga_resources:
        raise Exception("No LGA resources found")

    # Sort by period_end date — this is the most reliable field
    latest = sorted(lga_resources, key=lambda r: r["period_end"], reverse=True)[0]
    print(f"\n  Selected: {latest['name']}")
    print(f"  Period end: {latest['period_end']}")
    print(f"  URL: {latest['url']}")
    return latest["url"], latest["name"]

def download_file(url):
    print(f"\nDownloading Excel file...")
    try:
        urllib.request.urlretrieve(url, EXCEL_FILE)
        size_mb = os.path.getsize(EXCEL_FILE) / (1024 * 1024)
        print(f"  Saved: {EXCEL_FILE} ({size_mb:.1f} MB)")
    except urllib.error.URLError as e:
        raise Exception(f"Download failed: {e}")


def inspect_sheets():
    print("\nInspecting sheet structure...")
    all_sheets = pd.read_excel(EXCEL_FILE, sheet_name=None, nrows=2)
    for name, df in all_sheets.items():
        print(f"  {name}: {list(df.columns)}")
    return list(all_sheets.keys())


def find_sheet(sheet_names, keywords):
    for name in sheet_names:
        if any(kw.lower() in name.lower() for kw in keywords):
            return name
    return sheet_names[0]


def extract_lga_table(sheet_name):
    """
    Extract LGA-level data with Rate per 100,000 population.
    Expected columns: Year, Year ending, Police Region, Local Government Area,
                      Incidents Recorded, Rate per 100,000 population
    """
    print(f"\nExtracting LGA data from sheet: {sheet_name}")
    df = pd.read_excel(EXCEL_FILE, sheet_name=sheet_name)
    print(f"  Shape: {df.shape}, Columns: {list(df.columns)}")

    cols = df.columns.tolist()
    year_col = cols[0]
    lga_col = next((c for c in cols if "government area" in str(c).lower()), cols[3])
    incidents_col = next((c for c in cols if "incidents recorded" in str(c).lower()), cols[4])
    rate_col = next((c for c in cols if "rate" in str(c).lower() and "100" in str(c).lower()), cols[5])

    latest_year = df[year_col].dropna().max()
    df_latest = df[df[year_col] == latest_year].copy()
    print(f"  Latest year: {latest_year}, rows: {len(df_latest)}")

    result = {}
    for _, row in df_latest.iterrows():
        lga = str(row[lga_col]).strip()
        if lga in ("nan", "", "None") or pd.isna(row.get(incidents_col)):
            continue
        result[lga] = {
            "incidents": int(row[incidents_col]) if pd.notna(row[incidents_col]) else None,
            "ratePer100k": round(float(row[rate_col]), 1) if pd.notna(row.get(rate_col)) else None,
            "year": str(int(latest_year)) if pd.notna(latest_year) else "unknown",
        }

    print(f"  LGAs extracted: {len(result)}")
    with open(OUTPUT_LGA, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"  Saved: {OUTPUT_LGA}")
    return result


def extract_suburb_table(sheet_name):
    """
    Extract Suburb/Town level data with total incidents per suburb
    and top 5 offence subgroups by proportion.
    """
    print(f"\nExtracting Suburb data from sheet: {sheet_name}")
    df = pd.read_excel(EXCEL_FILE, sheet_name=sheet_name)
    print(f"  Shape: {df.shape}, Columns: {list(df.columns)}")

    cols = df.columns.tolist()
    year_col = cols[0]
    lga_col = next((c for c in cols if "government area" in str(c).lower()), cols[2])
    postcode_col = next((c for c in cols if "postcode" in str(c).lower()), cols[3])
    suburb_col = next((c for c in cols if "suburb" in str(c).lower() or "town" in str(c).lower()), cols[4])
    offence_subgroup_col = next((c for c in cols if "subgroup" in str(c).lower()), cols[7])
    incidents_col = next((c for c in cols if "incidents recorded" in str(c).lower()), cols[-1])

    latest_year = df[year_col].dropna().max()
    df_latest = df[df[year_col] == latest_year].copy()
    print(f"  Latest year: {latest_year}, rows: {len(df_latest)}")

    suburb_data = {}
    for _, row in df_latest.iterrows():
        suburb = str(row[suburb_col]).strip()
        postcode = str(row[postcode_col]).strip()
        lga = str(row[lga_col]).strip()
        subgroup = str(row[offence_subgroup_col]).strip()

        if suburb in ("nan", "", "None") or postcode in ("nan", "", "None"):
            continue

        key = f"{suburb}_{postcode}"
        if key not in suburb_data:
            suburb_data[key] = {
                "suburb": suburb,
                "postcode": postcode,
                "lga": lga,
                "totalIncidents": 0,
                "year": str(int(latest_year)) if pd.notna(latest_year) else "unknown",
                "note": "Raw count — not population normalised. Use LGA ratePer100k for scoring.",
                "_offenceSubgroups": {}  # temp field for calculating proportions
            }

        if pd.notna(row[incidents_col]):
            count = int(row[incidents_col])
            suburb_data[key]["totalIncidents"] += count

            if subgroup not in ("nan", "", "None"):
                suburb_data[key]["_offenceSubgroups"][subgroup] = (
                    suburb_data[key]["_offenceSubgroups"].get(subgroup, 0) + count
                )

    # Calculate top 5 offence proportions and remove temp field
    for entry in suburb_data.values():
        total = entry["totalIncidents"]
        subgroups = entry.pop("_offenceSubgroups")  # remove temp field
        if total > 0 and subgroups:
            top5 = sorted(subgroups.items(), key=lambda x: x[1], reverse=True)[:5]
            entry["topFiveOffenceProportion"] = {
                name: round(count / total, 4)
                for name, count in top5
            }
        else:
            entry["topFiveOffenceProportion"] = {}

    suburb_list = sorted(suburb_data.values(), key=lambda x: x["suburb"])
    print(f"  Suburbs extracted: {len(suburb_list)}")

    with open(OUTPUT_SUBURB, "w") as f:
        json.dump(suburb_list, f, indent=2, ensure_ascii=False)
    print(f"  Saved: {OUTPUT_SUBURB}")
    return suburb_data


def print_sample(lga_data, suburb_data):
    print("\n--- Sample LGA data (top 5 by rate) ---")
    sorted_lgas = sorted(
        [(k, v) for k, v in lga_data.items() if v["ratePer100k"]],
        key=lambda x: x[1]["ratePer100k"],
        reverse=True
    )
    for lga, data in sorted_lgas[:5]:
        print(f"  {lga}: {data['incidents']} incidents, {data['ratePer100k']} per 100k")

    print("\n--- Sample Suburb data (first 5 alphabetically) ---")
    suburbs = sorted(suburb_data.values(), key=lambda x: x["suburb"])
    for s in suburbs[:5]:
        print(f"  {s['suburb']} ({s['postcode']}, {s['lga']}): {s['totalIncidents']} incidents")


if __name__ == "__main__":
    try:
        file_url, file_name = get_latest_lga_file_url()
    except Exception as e:
        print(f"CKAN API failed: {e}")
        sys.exit(1)

    try:
        download_file(file_url)
    except Exception as e:
        print(f"Download failed: {e}")
        sys.exit(1)

    sheet_names = inspect_sheets()

    lga_sheet = find_sheet(sheet_names, ["Table 01", "01"])
    suburb_sheet = find_sheet(sheet_names, ["Table 03", "03"])
    print(f"\nUsing sheets: LGA={lga_sheet}, Suburb={suburb_sheet}")

    lga_data = extract_lga_table(lga_sheet)
    suburb_data = extract_suburb_table(suburb_sheet)

    print_sample(lga_data, suburb_data)

    print(f"\nOutput files:")
    print(f"  {OUTPUT_LGA}    — LGA name → incidents + rate per 100k (use for scoring)")
    print(f"  {OUTPUT_SUBURB} — suburb + postcode → total incidents (use for display)")
    print(f"\nNote: Data is published quarterly. Re-run this script each quarter for latest data.")
