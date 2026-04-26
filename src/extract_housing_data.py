"""
Victorian Housing Affordability Data Extractor
Uses the Victorian Government CKAN API (discover.data.vic.gov.au) to find and download
the latest housing sale price and rental data for Melbourne suburbs.

Datasets:
  1. Victorian Property Sales Report - Median House by Suburb (quarterly)
     CKAN ID: victorian-property-sales-report-median-house-by-suburb
     Granularity: Suburb — median house and unit sale prices

  2. Rental Report - Moving Annual Rents by Suburb (quarterly)
     CKAN ID: rental-report-quarterly-moving-annual-rents-by-suburb
     Granularity: Suburb — median weekly rent by property type

Output files (saved to ./housing_data/):
  house_prices_by_suburb.json  — median sale prices per suburb
  rent_by_suburb.json          — median weekly rent per suburb

Source: https://discover.data.vic.gov.au
License: Creative Commons Attribution 4.0 International
"""

import urllib.request
import urllib.error
import urllib.parse
import json
import os
import sys
import re
import tempfile

try:
    import pandas as pd
except ImportError:
    print("pandas not installed. Run: pip install pandas openpyxl xlrd")
    sys.exit(1)

CKAN_API = "https://discover.data.vic.gov.au/api/3/action"

HOUSE_PRICES_DATASET = "victorian-property-sales-report-median-house-by-suburb"
RENT_DATASET = "rental-report-quarterly-moving-annual-rents-by-suburb"

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "housing_data")
os.makedirs(OUTPUT_DIR, exist_ok=True)

OUTPUT_HOUSE = os.path.join(OUTPUT_DIR, "house_prices_by_suburb.json")
OUTPUT_RENT = os.path.join(OUTPUT_DIR, "rent_by_suburb.json")
RAW_DIR = os.path.join(OUTPUT_DIR, "raw")
os.makedirs(RAW_DIR, exist_ok=True)
RAW_HOUSE = os.path.join(RAW_DIR, "house_prices_raw.xls")
RAW_RENT = os.path.join(RAW_DIR, "rent_raw.xlsx")

MELBOURNE_LGAS = [
    "Banyule", "Bayside", "Boroondara", "Brimbank", "Cardinia",
    "Casey", "Darebin", "Frankston", "Glen Eira", "Greater Dandenong",
    "Hobsons Bay", "Hume", "Kingston", "Knox", "Manningham",
    "Maribyrnong", "Maroondah", "Melbourne", "Melton", "Merri-bek",
    "Monash", "Moonee Valley", "Mornington Peninsula", "Nillumbik",
    "Port Phillip", "Stonnington", "Whitehorse", "Whittlesea",
    "Wyndham", "Yarra", "Yarra Ranges",
]


def is_melbourne_lga(lga_name):
    lga_lower = str(lga_name).lower()
    return any(m.lower() in lga_lower for m in MELBOURNE_LGAS)


def get_latest_resource(dataset_id):
    """Use CKAN API to find the latest resource for a dataset."""
    print(f"\nQuerying CKAN API for: {dataset_id}")
    url = f"{CKAN_API}/package_show?id={dataset_id}"

    with urllib.request.urlopen(url) as response:
        data = json.loads(response.read())

    if not data.get("success"):
        raise Exception(f"CKAN API error: {data.get('error')}")

    resources = data["result"]["resources"]
    print(f"  Found {len(resources)} resources")

    # Filter to valid downloadable resources
    valid = [
        r for r in resources
        if r.get("url") and r["format"].upper() in ("XLS", "XLSX", ".XLS", ".XLSX")
    ]

    if not valid:
        raise Exception(f"No XLS/XLSX resources found for {dataset_id}")

    # Sort by period_end if available, otherwise by created date
    def sort_key(r):
        return r.get("period_end") or r.get("created") or ""

    latest = sorted(valid, key=sort_key, reverse=True)[0]
    print(f"  Selected: {latest['name']}")
    print(f"  URL: {latest['url']}")
    return latest["url"], latest["name"], latest.get("period_end", "unknown")


def download_file(url, dest_path):
    print(f"  Downloading to: {dest_path}")
    try:
        # req = urllib.request.Request(url, headers={
        #     "User-Agent": "Mozilla/5.0 (compatible; research script)"
        # })

        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*",
            "Referer": "https://www.land.vic.gov.au/",
        })

        with urllib.request.urlopen(req) as response, open(dest_path, "wb") as f:
            f.write(response.read())
        size_mb = os.path.getsize(dest_path) / (1024 * 1024)
        print(f"  Saved: {size_mb:.1f} MB → {dest_path}")
        return dest_path
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} — blocked. Please download manually from:")
        print(f"    {url}")
        print(f"  Save as: {dest_path}")
        return None


def inspect_file(filepath, suffix):
    """Read and print sheet names and first rows to help with debugging."""
    engine = "xlrd" if suffix == ".xls" else "openpyxl"
    try:
        all_sheets = pd.read_excel(filepath, sheet_name=None, header=None, nrows=6, engine=engine)
        print(f"  Sheets: {list(all_sheets.keys())}")
        for name, df in all_sheets.items():
            print(f"    Sheet '{name}':")
            for i, row in df.iterrows():
                print(f"      row {i}: {row.tolist()[:6]}")
        return list(all_sheets.keys()), engine
    except Exception as e:
        print(f"  Warning inspecting file: {e}")
        return [], engine


def extract_house_prices(filepath, engine, period_end):
    """
    Extract median house and unit prices by suburb.
    VPSR file structure:
      - Separate sheets per property type (house, unit)
      - Two header rows: row 0 = quarter labels, row 1 = Count/Median
      - Column 0 = region/LGA grouping
      - Column 1 = suburb name
      - Rightmost Median column = latest quarter median price
      - Group Total rows should be skipped
    """
    print(f"\nExtracting house prices...")
    all_sheets_raw = pd.read_excel(filepath, sheet_name=None, header=None, engine=engine)
    print(f"  Available sheets: {list(all_sheets_raw.keys())}")

    result = {}

    for sheet_name, df_raw in all_sheets_raw.items():
        sheet_lower = sheet_name.lower().strip()

        if any(k in sheet_lower for k in ["house", "houses"]):
            price_key = "medianHousePrice"
            sales_key = "houseSalesCount"
        elif any(k in sheet_lower for k in ["unit", "units", "apartment"]):
            price_key = "medianUnitPrice"
            sales_key = "unitSalesCount"
        else:
            continue

        print(f"  Processing sheet: '{sheet_name}' → {price_key}")

        # Find the row containing Count/Median headers
        header_row2 = None
        for i, row in df_raw.iterrows():
            vals = [str(v).strip().lower() for v in row.values]
            if "median" in vals or "count" in vals:
                header_row2 = i
                break

        if header_row2 is None:
            print(f"    Could not find header rows — skipping")
            continue

        # Read with two header rows
        # df = pd.read_excel(filepath, sheet_name=sheet_name,
        #                    header=[header_row2 - 1, header_row2], engine=engine)
        
        df = pd.read_excel(filepath, sheet_name=sheet_name,
                   header=[header_row2 - 1, header_row2], engine=engine)
        df = df.dropna(how='all')

        # Flatten multi-level columns
        df.columns = [
            f"{str(a).strip()}_{str(b).strip()}"
            if "Unnamed" not in str(a) and str(a).strip() != ""
            else str(b).strip()
            for a, b in df.columns
        ]

        cols = df.columns.tolist()
        print(f"    All columns: {cols}")
        print(f"    First 3 data rows:")
        print(df.head(3).to_string())

        print(f"    Columns (first 8): {cols[:8]}")

        # Suburb = col 1, LGA/region = col 0
        suburb_col = cols[1]
        lga_col = cols[0]

        # Find all Median columns — use the last one (most recent quarter)
        median_cols = [c for c in cols if "Median" in str(c) or "median" in str(c)]
        count_cols = [c for c in cols if "Count" in str(c) or "No." in str(c)]

        if not median_cols:
            median_cols = [c for c in cols[2:] if
                           pd.to_numeric(df[c], errors="coerce").notna().sum() > 3]

        latest_median_col = median_cols[-1] if median_cols else None
        latest_count_col = count_cols[-1] if count_cols else None
        print(f"    price col: {latest_median_col}, sales col: {latest_count_col}")

        for _, row in df.iterrows():
            suburb = str(row[suburb_col]).strip()
            if not suburb or suburb.lower() in ("nan", "", "none", "suburb", "town"):
                continue
            if "group total" in suburb.lower() or "total" in suburb.lower():
                continue

            lga = str(row.get(lga_col, "")).strip()
            if lga.lower() in ("nan", "", "none"):
                continue

            # if lga and not is_melbourne_lga(lga):
            #     continue

            price = None
            if latest_median_col and pd.notna(row.get(latest_median_col)):
                try:
                    price = int(float(str(row[latest_median_col]).replace(",", "").replace("$", "")))
                except (ValueError, TypeError):
                    pass

            sales = None
            if latest_count_col and pd.notna(row.get(latest_count_col)):
                try:
                    sales = int(float(str(row[latest_count_col]).replace(",", "")))
                except (ValueError, TypeError):
                    pass

            if suburb not in result:
                result[suburb] = {
                    "suburb": suburb,
                    "lga": lga if lga.lower() not in ("nan", "", "none") else None,
                    "period": period_end,
                }

            if price is not None:
                result[suburb][price_key] = price
            if sales is not None:
                result[suburb][sales_key] = sales

    suburb_list = sorted(result.values(), key=lambda x: x["suburb"])
    print(f"  Suburbs extracted: {len(suburb_list)}")
    return suburb_list


def extract_rent(filepath, engine, period_end):
    """
    Extract median weekly rent by suburb and property type.
    File structure:
      - One sheet per property type (1 bedroom flat, 2 bedroom house etc.)
      - Two header rows: row 0 = quarter labels, row 1 = Count/Median
      - Column 0 = region grouping
      - Column 1 = suburb name
      - Rightmost Median column = latest quarter median rent
      - Group Total rows should be skipped
    """
    print(f"\nExtracting rental data...")

    TYPE_MAP = {
        "1 bedroom flat":  "1brFlat",
        "2 bedroom flat":  "2brFlat",
        "3 bedroom flat":  "3brFlat",
        "2 bedroom house": "2brHouse",
        "3 bedroom house": "3brHouse",
        "4 bedroom house": "4brHouse",
        "all properties":  "all",
    }

    all_sheets_raw = pd.read_excel(filepath, sheet_name=None, header=None, engine=engine)
    print(f"  Available sheets: {list(all_sheets_raw.keys())}")

    result = {}

    for sheet_name, df_raw in all_sheets_raw.items():
        type_key = TYPE_MAP.get(sheet_name.lower().strip())
        if not type_key:
            continue

        print(f"  Processing sheet: '{sheet_name}' → {type_key}")

        # Find the row containing Count/Median headers
        header_row2 = None
        for i, row in df_raw.iterrows():
            vals = [str(v).strip().lower() for v in row.values]
            if "median" in vals or "count" in vals:
                header_row2 = i
                break

        if header_row2 is None:
            print(f"    Could not find header rows — skipping")
            continue

        # Read with two header rows
        df = pd.read_excel(filepath, sheet_name=sheet_name,
                           header=[header_row2 - 1, header_row2], engine=engine)

        # Flatten multi-level columns
        df.columns = [
            f"{str(a).strip()}_{str(b).strip()}"
            if "Unnamed" not in str(a) and str(a).strip() != ""
            else str(b).strip()
            for a, b in df.columns
        ]
        cols = df.columns.tolist()
        df = df.dropna(how='all')
        df[cols[0]] = df[cols[0]].ffill()

        # Suburb = col 1, region = col 0
        suburb_col = cols[1]
        lga_col = cols[0]

        # Find all Median columns — use the last one (most recent quarter)
        median_cols = [c for c in cols if "Median" in str(c) or "median" in str(c)]
        if not median_cols:
            median_cols = [c for c in cols[2:] if
                           pd.to_numeric(df[c], errors="coerce").notna().sum() > 3]

        latest_col = median_cols[-1] if median_cols else None
        print(f"    rent col: {latest_col}")

        for _, row in df.iterrows():
            suburb = str(row[suburb_col]).strip()
            if not suburb or suburb.lower() in ("nan", "", "none", "suburb", "town"):
                continue
            if "group total" in suburb.lower() or "total" in suburb.lower():
                continue

            lga = str(row.get(lga_col, "")).strip()

            # if lga and not is_melbourne_lga(lga):
            #     continue

            rent = None
            if latest_col and pd.notna(row.get(latest_col)):
                try:
                    rent = int(float(str(row[latest_col]).replace(",", "").replace("$", "")))
                except (ValueError, TypeError):
                    pass

            if suburb not in result:
                result[suburb] = {
                    "suburb": suburb,
                    "lga": lga if lga.lower() not in ("nan", "", "none") else None,
                    "period": period_end,
                    "weeklyRent": {}
                }

            if rent is not None:
                result[suburb]["weeklyRent"][type_key] = rent

    suburb_list = sorted(result.values(), key=lambda x: x["suburb"])
    print(f"  Suburbs extracted: {len(suburb_list)}")
    return suburb_list


if __name__ == "__main__":

# House prices
    try:
        url, name, period_end = get_latest_resource(HOUSE_PRICES_DATASET)
        suffix = ".xls" if url.lower().endswith(".xls") else ".xlsx"
        raw_path = RAW_HOUSE.replace(".xls", suffix)
        filepath = download_file(url, raw_path)
        if filepath:
            _, engine = inspect_file(filepath, suffix)
            house_data = extract_house_prices(filepath, engine, period_end)
            with open(OUTPUT_HOUSE, "w") as f:
                json.dump(house_data, f, indent=2, ensure_ascii=False)
            print(f"\n  Saved: {OUTPUT_HOUSE} ({len(house_data)} suburbs)")
    except Exception as e:
        print(f"House price extraction failed: {e}")

    # Rent
    try:
        url, name, period_end = get_latest_resource(RENT_DATASET)
        suffix = ".xls" if url.lower().endswith(".xls") else ".xlsx"
        raw_path = RAW_RENT.replace(".xlsx", suffix)
        filepath = download_file(url, raw_path)
        if filepath:
            _, engine = inspect_file(filepath, suffix)
            rent_data = extract_rent(filepath, engine, period_end)
            with open(OUTPUT_RENT, "w") as f:
                json.dump(rent_data, f, indent=2, ensure_ascii=False)
            print(f"\n  Saved: {OUTPUT_RENT} ({len(rent_data)} suburbs)")
    except Exception as e:
        print(f"Rental extraction failed: {e}")

    print(f"\nOutput directory: {OUTPUT_DIR}")
    print(f"  house_prices_by_suburb.json — median sale prices by suburb")
    print(f"  rent_by_suburb.json         — median weekly rent by suburb")
    print(f"\nNote: Data is published quarterly. Re-run each quarter for latest data.")
