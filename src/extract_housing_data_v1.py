"""
Victorian Housing Affordability Data Extractor
Uses the Victorian Government CKAN API (discover.data.vic.gov.au) to find and download
the latest housing sale price and rental data for Melbourne suburbs.

Datasets:
  1. Victorian Property Sales Report - Median House by Suburb (quarterly)
     CKAN ID: victorian-property-sales-report-median-house-by-suburb
     Source: land.vic.gov.au — may be blocked, manual download fallback provided
     File structure: Single sheet, 3-row multi-line header, UPPERCASE suburb names
       Col 0 = Locality, Cols 1-5 = quarterly medians, Col 5 = latest, Col 6 = sales count

  2. Victorian Property Sales Report - Median Unit by Suburb (quarterly)
     CKAN ID: victorian-property-sales-report-median-unit-by-suburb
     Source: land.vic.gov.au — may be blocked, manual download fallback provided
     File structure: Single sheet, 3-row multi-line header, UPPERCASE suburb names
       Col 0 = Locality, Cols 1-5 = quarterly medians, Col 5 = latest, Col 6 = sales count

  3. Rental Report - Moving Annual Rents by Suburb (quarterly)
     CKAN ID: rental-report-quarterly-moving-annual-rents-by-suburb
     Source: dffh.vic.gov.au
     File structure: One sheet per property type, 3-row header (title + quarter + Count/Median)
       Col 0 = region (forward-filled), Col 1 = suburb group, last Median col = latest rent

Output files (saved to ./src/housing_data/):
  house_prices_by_suburb.json  — median sale prices per suburb
  unit_prices_by_suburb.json   — median unit prices per suburb
  rent_by_suburb.json          — median weekly rent per suburb group

Raw files saved to ./src/housing_data/raw/ for debugging.

Source: https://discover.data.vic.gov.au
License: Creative Commons Attribution 4.0 International
"""

import urllib.request
import urllib.error
import json
import os
import sys
import re

try:
    import pandas as pd
except ImportError:
    print("pandas not installed. Run: pip install pandas openpyxl xlrd")
    sys.exit(1)

# API's and Datasets
CKAN_API = "https://discover.data.vic.gov.au/api/3/action"
HOUSE_PRICES_DATASET = "victorian-property-sales-report-median-house-by-suburb"
UNIT_PRICES_DATASET = "victorian-property-sales-report-median-unit-by-suburb"
RENT_DATASET = "rental-report-quarterly-moving-annual-rents-by-suburb"

# Directories
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "housing_data")
RAW_DIR = os.path.join(OUTPUT_DIR, "raw")
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(RAW_DIR, exist_ok=True)

# Paths
OUTPUT_HOUSE_UNIT = os.path.join(OUTPUT_DIR, "house_unit_prices_by_suburb.json")
OUTPUT_RENT = os.path.join(OUTPUT_DIR, "rent_by_suburb.json")

# Manual Download Files as a fallback if automated download is blocked (save files manually with these names):
RAW_HOUSE = os.path.join(RAW_DIR, "house_prices_raw.xls")
RAW_UNIT = os.path.join(RAW_DIR, "unit_prices_raw.xls")
RAW_RENT = os.path.join(RAW_DIR, "rent_raw.xlsx")

# =============================================================================
# CKAN API
# =============================================================================

# use typeing hints for the function below
def get_latest_resource(dataset_id: str) -> tuple[str, str, str]:
    """
    Use CKAN API to find the latest resource URL and period for a dataset.
    Args:
        - dataset_id (str): CKAN dataset ID to query
    Returns:
        - url (str): URL of the latest resource file
        - name (str): Name of the resource
        - period_end (str): Period end date (if available) or "unknown"
    """
    print(f"\nQuerying CKAN API for: {dataset_id}")
    url = f"{CKAN_API}/package_show?id={dataset_id}"

    with urllib.request.urlopen(url) as response:
        data = json.loads(response.read())

    if not data.get("success"):
        raise Exception(f"CKAN API error: {data.get('error')}")

    resources = data["result"]["resources"]
    print(f"  Found {len(resources)} resources")

    valid = [r for r in resources if r.get("url") and r.get("period_end")]
    if not valid:
        valid = [r for r in resources if r.get("url")]

    latest = sorted(valid, key=lambda r: r.get("period_end") or r.get("created") or "", reverse=True)[0]
    print(f"  Selected: {latest['name']}")
    print(f"  URL: {latest['url']}")
    print(f"  Period end: {latest.get('period_end', 'unknown')}")
    return latest["url"], latest["name"], latest.get("period_end", "unknown")


# =============================================================================
# DOWNLOAD
# =============================================================================

def download_file(url: str, dest_path: str) -> str | None:
    """
    Download file to dest_path. Returns path on success, None on failure.
    Args:
        - url (str): URL to download
        - dest_path (str): Local path to save the file
    Returns:
        - str: Path to the saved file on success
        - None: If download fails (e.g. blocked by server)
    """
    print(f"  Downloading to: {dest_path}")
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://www.land.vic.gov.au/",
            "Accept": "application/vnd.ms-excel,"
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
        })
        with urllib.request.urlopen(req) as response, open(dest_path, "wb") as f:
            f.write(response.read())
        size_mb = os.path.getsize(dest_path) / (1024 * 1024)
        print(f"  Saved: {size_mb:.1f} MB")
        return dest_path
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} — download blocked.")
        return None
    except urllib.error.URLError as e:
        print(f"  URL error: {e}")
        return None


# =============================================================================
# INSPECTION
# =============================================================================

def inspect_file(filepath: str, suffix: str) -> tuple[list[str], str]:
    """
    Print sheet names and first rows for debugging.
    Args:
        - filepath (str): Path to the Excel file
        - suffix (str): File suffix to determine engine (".xls" or ".xlsx")
    Returns:
        - tuple[list[str], str]: List of sheet names and engine used for reading
    """
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


# =============================================================================
# EXTRACT HOUSE PRICES
# =============================================================================

def extract_house_prices(filepath: str, engine: str, period_end: str) -> pd.DataFrame:
    """
    Extract median house prices by suburb.
    File structure:
        - Single sheet
        - Multi-line header (3 rows): Locality, quarterly medians Apr-Jun 2024 to Apr-Jun 2025,
            No. of Sales, Change (%)
        - Column 0 = suburb name (UPPERCASE)
        - Column 5 = latest quarter median price (Apr-Jun 2025)
        - Column 6 = No. of Sales latest quarter
        - Some prices have ^ suffix indicating small sample — stripped before parsing
    Args:
        - filepath (str): Path to the Excel file
        - engine (str): Engine to use for reading the file ("xlrd" for .xls, "openpyxl" for .xlsx)
        - period_end (str): End date of the period for which to extract prices
    Returns:
        - pd.DataFrame: DataFrame with columns: suburb, mean_price_for_period
    """
    print(f"\nExtracting house prices from: {os.path.basename(filepath)}")

    # Read excel file and concatenate each the first 4 rows in each column to create a single header row
    df_raw = pd.read_excel(filepath, header=None, nrows=4, engine=engine)
    # Cast all columns to object dtype to allow mixed string/float values
    df_raw = df_raw.astype(object)

    # for each column that has a non-empty value in the first rows, concatenate those values with space to create a single header row
    column_names = []
    for col in df_raw.columns:
        header_parts = []
        for i in range(4):
            if df_raw.iloc[i, col] is not None and str(df_raw.iloc[i, col]).strip().lower() not in ("nan", "", "none"):
                val = str(df_raw.iloc[i, col]).strip()
                header_parts.append(val)
        # join all header parts with an underscore and set as the new header for that column
        new_col = "_".join(header_parts).replace(" ", "_")
        column_names.append(new_col)

    # drop all empty entries from header row:
    column_names = [c for c in column_names if c.strip() != ""]

    # Now read the file again with no header rows. if any column excluding column 0 contains "^" delete that column
    df_body = pd.read_excel(filepath, header=None, skiprows=4, engine=engine)
    for col in df_body.columns[1:]:
        if df_body[col].astype(str).str.contains("\^").any():
            print(f"  Dropping column {col} because it contains '^'")
            df_body = df_body.drop(columns=[col])

    # if the length of the header row is the same as the number of columns in the body, set the header row as the column names for the body and drop any fully empty rows
    if len(column_names) == len(df_body.columns):
        df_body.columns = column_names
        df_body = df_body.dropna(how="all")
    else:
        print(f"  Warning: header row length {len(column_names)} does not match body column count {len(df_body.columns)}")  

    # Create mean_house_price_period from the average of all columns matching format: mmm-mmm_yyyy
    price_cols = [c for c in df_body.columns if re.match(r'^[A-Z][a-z]{2}-[A-Z][a-z]{2}_\d{4}$', str(c))]
    # print(f"  Price columns: {price_cols}")

    # create mean_house_price_period by averaging all price columns for each row, ignoring non-numeric values
    df_body["mean_price_for_period"] = df_body[price_cols].apply(pd.to_numeric, errors="coerce").mean(axis=1)
    # create output dataframe with suburb and mean price over the period (to smooth out any anomalies in the latest quarter), and convert suburb to title case
    df_output = df_body[["Locality", "mean_price_for_period"]].rename(columns={"Locality": "suburb"})
    df_output["suburb"] = df_output["suburb"].str.title()
    return df_output

# =============================================================================
# EXTRACT RENT
# =============================================================================

def extract_rent(filepath: str, engine: str, period_end: str) -> list[dict]:
    """
    Extract median weekly rent by suburb group and property type.
    File structure:
        - One sheet per property type (1 bedroom flat, 2 bedroom house etc.)
        - Row 0 = title row
        - Row 1 = quarter labels
        - Row 2 = Count/Median headers
        - Col 0 = region (forward-filled), Col 1 = suburb group name
        - Last Median column = latest quarter median rent
        - Group Total rows skipped
    Args:
        - filepath (str): Path to the Excel file
        - engine (str): Engine to use for reading the file ("xlrd" for .xls, "openpyxl" for .xlsx)
        - period_end (str): End date of the period for which to extract rents
    Returns:
        - list[dict]: List of suburb group dicts with structure:
        {
        "suburbs": [list of suburbs in the group],
        "region": region name (or None if not available),
        "period": period_end,
        "weeklyRent": {
        "1brFlat": median rent for 1 bedroom flats (or None if not available),
        "2brFlat": median rent for 2 bedroom flats (or None if not available),
        "3brFlat": median rent for 3 bedroom flats (or None if not available),
        "2brHouse": median rent for 2 bedroom houses (or None if not available),
        "3brHouse": median rent for 3 bedroom houses (or None if not available),
        "4brHouse": median rent for 4 bedroom houses (or None if not available),
        "all": median rent for all properties (or None if not available)
        }
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

        # Read with two header rows (quarter label + Count/Median)
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

        # Drop fully empty rows (title row becomes empty after header parsing)
        df = df.dropna(how="all")

        # Col 0 = region (forward-fill NaN), Col 1 = suburb group
        region_col = cols[0]
        suburb_col = cols[1]
        df[region_col] = df[region_col].ffill()

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
            if "group total" in suburb.lower() or suburb.lower() == "total":
                continue

            region = str(row.get(region_col, "")).strip()

            rent = None
            if latest_col and pd.notna(row.get(latest_col)):
                try:
                    rent = int(float(str(row[latest_col]).replace(",", "").replace("$", "")))
                except (ValueError, TypeError):
                    pass

            if suburb not in result:
                suburbs_list = [s.strip() for s in suburb.split("-")]
                result[suburb] = {
                    "suburbs": suburbs_list,
                    "region": region if region.lower() not in ("nan", "", "none") else None,
                    "period": period_end,
                    "weeklyRent": {}
                }

            if rent is not None:
                result[suburb]["weeklyRent"][type_key] = rent

    suburb_list = sorted(result.values(), key=lambda x: x["suburbs"][0])
    print(f"  Suburb groups extracted: {len(suburb_list)}")
    return suburb_list

def victorian_property_download_process(prices_dataset: str, raw_data: str) -> pd.DataFrame:
    """
    Download and extract Victorian property price data (house or unit) from CKAN dataset.
    
    Args:
        - prices_dataset (str): CKAN dataset ID for the property prices (house or unit)
        - raw_data: Path to save the raw downloaded file (used for both house and unit prices, e.g. raw/house_prices_raw.xls)

    Returns:
        - DataFrame with columns: suburb, mean_price_for_period
    """
    url, name, period_end = get_latest_resource(prices_dataset)
    suffix = ".xls" if url.lower().endswith(".xls") else ".xlsx"
    raw_path = raw_data.replace(".xls", suffix)

    if os.path.exists(raw_path):
        print(f"  Raw file already exists — skipping download: {raw_path}")
        filepath = raw_path
    else:
        print(f"  Attempting download...")
        filepath = download_file(url, raw_path)
        if not filepath:
            print(f"\n  ACTION REQUIRED — automated download blocked.")
            print(f"  1. Open this URL in your browser:\n     {url}")
            print(f"  2. Save the file as:\n     {raw_path}")
            print(f"  3. Re-run the script")

    if filepath and os.path.exists(filepath):
        suffix = ".xls" if filepath.endswith(".xls") else ".xlsx"
        engine = "xlrd" if suffix == ".xls" else "openpyxl"
        inspect_file(filepath, suffix)
        house_data = extract_house_prices(filepath, engine, period_end)
        return house_data
    

# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":

    # --- House Prices ---
    print("\n" + "=" * 60)
    print("HOUSE PRICES")
    print("=" * 60)
    try:
        house_prices = victorian_property_download_process(HOUSE_PRICES_DATASET, RAW_HOUSE)
        print(house_prices.head())

    except Exception as e:
        print(f"House price extraction failed: {e}")
        import traceback; traceback.print_exc()

    # --- Unit Prices ---
    print("\n" + "=" * 60)
    print("UNIT PRICES")
    print("=" * 60)
    try:
        unit_prices = victorian_property_download_process(UNIT_PRICES_DATASET, RAW_UNIT)
        print(unit_prices.head())

    except Exception as e:
        print(f"Unit price extraction failed: {e}")
        import traceback; traceback.print_exc()

    # if no exceptions, merge house and unit prices on suburb and save to output
    if 'house_prices' in locals() and 'unit_prices' in locals():
        merged = pd.merge(house_prices, unit_prices, on="suburb", how="outer", suffixes=("_house", "_unit"))
        merged = merged.rename(columns={
            "mean_price_for_period_house": "meanMedianHousePrice",
            "mean_price_for_period_unit": "meanMedianUnitPrice"
        })
        output_data = merged[["suburb", "meanMedianHousePrice", "meanMedianUnitPrice"]].to_dict(orient="records")
        with open(OUTPUT_HOUSE_UNIT, "w") as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)
        print(f"\n  Saved: {OUTPUT_HOUSE_UNIT} ({len(output_data)} suburbs)")


    # --- Rent ---
    print("\n" + "=" * 60)
    print("RENTAL DATA")
    print("=" * 60)
    try:
        url, name, period_end = get_latest_resource(RENT_DATASET)
        suffix = ".xls" if url.lower().endswith(".xls") else ".xlsx"
        raw_path = RAW_RENT.replace(".xlsx", suffix)

        if os.path.exists(raw_path):
            print(f"  Raw file already exists — skipping download: {raw_path}")
            filepath = raw_path
        else:
            print(f"  Attempting download...")
            filepath = download_file(url, raw_path)

        if filepath and os.path.exists(filepath):
            suffix = ".xls" if filepath.endswith(".xls") else ".xlsx"
            engine = "xlrd" if suffix == ".xls" else "openpyxl"
            inspect_file(filepath, suffix)
            rent_data = extract_rent(filepath, engine, period_end)
            with open(OUTPUT_RENT, "w") as f:
                json.dump(rent_data, f, indent=2, ensure_ascii=False)
            print(f"\n  Saved: {OUTPUT_RENT} ({len(rent_data)} suburb groups)")

    except Exception as e:
        print(f"Rental extraction failed: {e}")
        import traceback; traceback.print_exc()

    print(f"\nOutput directory: {OUTPUT_DIR}")
    print(f"  house_prices_by_suburb.json — median sale prices by suburb")
    print(f"  rent_by_suburb.json         — median weekly rent by suburb group")
    print(f"  raw/                        — raw downloaded files for debugging")
    print(f"\nNote: Data is published quarterly. Re-run each quarter for latest data.")
    print(f"      Delete raw files to force re-download.")
