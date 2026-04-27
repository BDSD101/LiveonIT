"""
Victorian Data Extractor
Uses the Victorian Government CKAN API (discover.data.vic.gov.au) to find and download
the latest housing and crime data for Melbourne suburbs.

Datasets:
  Housing:
    1. Victorian Property Sales Report - Median House by Suburb (quarterly)
       CKAN ID: victorian-property-sales-report-median-house-by-suburb
       Source: land.vic.gov.au — may be blocked, manual download fallback provided
    2. Victorian Property Sales Report - Median Unit by Suburb (quarterly)
       CKAN ID: victorian-property-sales-report-median-unit-by-suburb
       Source: land.vic.gov.au — may be blocked, manual download fallback provided
    3. Rental Report - Moving Annual Rents by Suburb (quarterly)
       CKAN ID: rental-report-quarterly-moving-annual-rents-by-suburb
       Source: dffh.vic.gov.au

  Crime:
    4. Criminal Incidents by LGA and Suburb (quarterly)
       CKAN ID: criminal-incident
       Source: files.crimestatistics.vic.gov.au

  Suburbs:
    5. List of Melbourne suburbs with postcodes and LGAs
       Source: Wikipedia API (en.wikipedia.org/wiki/List_of_Melbourne_suburbs)

Output files:
  housing_data/house_unit_prices_by_suburb.json — median sale prices per suburb
  housing_data/rent_by_suburb.json              — median weekly rent per suburb group
  crime_data/crime_by_lga.json                  — incidents + rate per 100k by LGA
  crime_data/crime_by_suburb.json               — total incidents by suburb + postcode
  suburb_data/melbourne_suburbs_by_lga.json     — suburb + postcode list per LGA

Raw files saved to ./housing_data/raw/ and ./crime_data/ for debugging.

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

try:
    import pandas as pd
except ImportError:
    print("pandas not installed. Run: pip install pandas openpyxl xlrd")
    sys.exit(1)

# =============================================================================
# CONSTANTS
# =============================================================================

CKAN_API = "https://discover.data.vic.gov.au/api/3/action"

# Housing dataset IDs
HOUSE_PRICES_DATASET = "victorian-property-sales-report-median-house-by-suburb"
UNIT_PRICES_DATASET  = "victorian-property-sales-report-median-unit-by-suburb"
RENT_DATASET         = "rental-report-quarterly-moving-annual-rents-by-suburb"

# Crime dataset ID
CRIME_DATASET = "criminal-incident"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Housing paths
HOUSING_DIR  = os.path.join(SCRIPT_DIR, "housing_data")
HOUSING_RAW  = os.path.join(HOUSING_DIR, "raw")
OUTPUT_HOUSE_UNIT = os.path.join(HOUSING_DIR, "house_unit_prices_by_suburb.json")
OUTPUT_RENT       = os.path.join(HOUSING_DIR, "rent_by_suburb.json")
RAW_HOUSE = os.path.join(HOUSING_RAW, "house_prices_raw.xls")
RAW_UNIT  = os.path.join(HOUSING_RAW, "unit_prices_raw.xls")
RAW_RENT  = os.path.join(HOUSING_RAW, "rent_raw.xlsx")

# Crime paths
CRIME_DIR     = os.path.join(SCRIPT_DIR, "crime_data")
CRIME_EXCEL   = os.path.join(CRIME_DIR, "crime_incidents_lga.xlsx")
OUTPUT_LGA    = os.path.join(CRIME_DIR, "crime_by_lga.json")
OUTPUT_SUBURB = os.path.join(CRIME_DIR, "crime_by_suburb.json")

# Suburb paths
SUBURB_DIR            = os.path.join(SCRIPT_DIR, "suburb_data")
WIKIPEDIA_API         = "https://en.wikipedia.org/w/api.php"
OUTPUT_SUBURBS_BY_LGA = os.path.join(SUBURB_DIR, "melbourne_suburbs_by_lga.json")


for d in (HOUSING_DIR, HOUSING_RAW, CRIME_DIR, SUBURB_DIR):
    os.makedirs(d, exist_ok=True)


# =============================================================================
# SHARED UTILITIES
# =============================================================================

def get_latest_resource(dataset_id: str, url_filter: str | None = None) -> tuple[str, str, str]:
    """
    Query the CKAN API and return the URL, name, and period_end of the latest resource.
    Args:
        - dataset_id (str): CKAN dataset ID to query.
        - url_filter (str | None): If provided, only consider resources whose URL starts
          with this prefix (e.g. to pin to a specific host).
    Returns:
        - url (str): Direct download URL of the latest resource.
        - name (str): Resource name (for logging).
        - period_end (str): Period end date, or "unknown" if not available.
    """
    print(f"\nQuerying CKAN API for: {dataset_id}")
    api_url = f"{CKAN_API}/package_show?id={dataset_id}"

    with urllib.request.urlopen(api_url) as response:
        data = json.loads(response.read())

    if not data.get("success"):
        raise Exception(f"CKAN API error: {data.get('error')}")

    resources = data["result"]["resources"]
    print(f"  Found {len(resources)} resources")

    valid = [r for r in resources if r.get("url")]
    if url_filter:
        valid = [r for r in valid if r["url"].startswith(url_filter)]

    # Prefer resources with a period_end date; fall back to created date
    with_period = [r for r in valid if r.get("period_end")]
    pool = with_period if with_period else valid
    latest = sorted(pool, key=lambda r: r.get("period_end") or r.get("created") or "", reverse=True)[0]

    print(f"  Selected: {latest['name']}")
    print(f"  URL: {latest['url']}")
    print(f"  Period end: {latest.get('period_end', 'unknown')}")
    return latest["url"], latest["name"], latest.get("period_end", "unknown")


def download_file(url: str, dest_path: str, extra_headers: dict | None = None) -> str | None:
    """
    Download a file to dest_path. Returns the path on success, None on failure.
    Args:
        - url (str): URL to download.
        - dest_path (str): Local path to save the file.
        - extra_headers (dict | None): Additional HTTP headers to include in the request.
    Returns:
        - str: Path to the saved file on success.
        - None: If the download fails (e.g. blocked by server).
    """
    print(f"  Downloading to: {dest_path}")
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": (
            "application/vnd.ms-excel,"
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*"
        ),
    }
    if extra_headers:
        headers.update(extra_headers)

    try:
        req = urllib.request.Request(url, headers=headers)
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


def resolve_engine(filepath: str) -> tuple[str, str]:
    """Return (suffix, engine) for an Excel file path."""
    suffix = ".xls" if filepath.endswith(".xls") else ".xlsx"
    engine = "xlrd" if suffix == ".xls" else "openpyxl"
    return suffix, engine


def inspect_sheets(filepath: str, engine: str, nrows: int = 6) -> list[str]:
    """
    Print sheet names and first rows for debugging.
    Args:
        - filepath (str): Path to the Excel file.
        - engine (str): Pandas engine to use ("xlrd" or "openpyxl").
        - nrows (int): Number of rows to read per sheet.
    Returns:
        - list[str]: Sheet names found in the file.
    """
    try:
        all_sheets = pd.read_excel(filepath, sheet_name=None, header=None, nrows=nrows, engine=engine)
        print(f"  Sheets: {list(all_sheets.keys())}")
        for name, df in all_sheets.items():
            print(f"    Sheet '{name}':")
            for i, row in df.iterrows():
                print(f"      row {i}: {row.tolist()[:6]}")
        return list(all_sheets.keys())
    except Exception as e:
        print(f"  Warning inspecting file: {e}")
        return []


def find_sheet(sheet_names: list[str], keywords: list[str]) -> str:
    """
    Return the first sheet name containing any of the keywords (case-insensitive).
    Falls back to the first sheet if no match is found.
    Args:
        - sheet_names (list[str]): List of sheet names to search.
        - keywords (list[str]): Keywords to look for in sheet names.
    Returns:
        - str: Matching sheet name, or the first sheet name as a fallback.
    """
    for name in sheet_names:
        if any(kw.lower() in name.lower() for kw in keywords):
            return name
    return sheet_names[0]


# =============================================================================
# HOUSING — EXTRACT
# =============================================================================

def extract_house_prices(filepath: str, engine: str, period_end: str) -> pd.DataFrame:
    """
    Extract median house (or unit) prices by suburb.
    File structure:
        - Single sheet, 4-row multi-line header, UPPERCASE suburb names.
        - Col 0 = Locality, remaining cols = quarterly medians.
        - Columns with a '^' suffix (small sample) are dropped.
        - mean_price_for_period = average of all quarterly price columns.
    Args:
        - filepath (str): Path to the Excel file.
        - engine (str): Pandas engine to use.
        - period_end (str): Period end label (stored for reference).
    Returns:
        - pd.DataFrame: Columns — suburb (title case), mean_price_for_period.
    """
    print(f"\nExtracting house prices from: {os.path.basename(filepath)}")

    df_raw = pd.read_excel(filepath, header=None, nrows=4, engine=engine)
    df_raw = df_raw.astype(object)

    column_names = []
    for col in df_raw.columns:
        parts = [
            str(df_raw.iloc[i, col]).strip()
            for i in range(4)
            if df_raw.iloc[i, col] is not None
            and str(df_raw.iloc[i, col]).strip().lower() not in ("nan", "", "none")
        ]
        column_names.append("_".join(parts).replace(" ", "_"))

    column_names = [c for c in column_names if c.strip()]

    df_body = pd.read_excel(filepath, header=None, skiprows=4, engine=engine)
    for col in df_body.columns[1:]:
        if df_body[col].astype(str).str.contains(r"\^").any():
            df_body = df_body.drop(columns=[col])

    if len(column_names) == len(df_body.columns):
        df_body.columns = column_names
        df_body = df_body.dropna(how="all")
    else:
        print(
            f"  Warning: header length {len(column_names)} "
            f"!= body column count {len(df_body.columns)}"
        )

    price_cols = [c for c in df_body.columns if re.match(r'^[A-Z][a-z]{2}-[A-Z][a-z]{2}_\d{4}$', str(c))]
    df_body["mean_price_for_period"] = (
        df_body[price_cols].apply(pd.to_numeric, errors="coerce").mean(axis=1)
    )
    df_body = df_body.dropna(subset=["mean_price_for_period"])
    df_output = (
        df_body[["Locality", "mean_price_for_period"]]
        .rename(columns={"Locality": "suburb"})
    )
    df_output["suburb"] = df_output["suburb"].str.title()
    return df_output


def extract_rent(filepath: str, engine: str, period_end: str) -> list[dict]:
    """
    Extract median weekly rent by suburb group and property type.
    File structure:
        - One sheet per property type (e.g. "1 bedroom flat", "2 bedroom house").
        - Row 0 = title, Row 1 = quarter labels, Row 2 = Count/Median headers.
        - Col 0 = region (forward-filled), Col 1 = suburb group name.
        - Last Median column = latest quarter.
    Args:
        - filepath (str): Path to the Excel file.
        - engine (str): Pandas engine to use.
        - period_end (str): Period end label attached to each record.
    Returns:
        - list[dict]: One entry per suburb group with keys:
            suburbs, region, period, weeklyRent (dict keyed by property type).
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

    result: dict[str, dict] = {}

    for sheet_name, df_raw in all_sheets_raw.items():
        type_key = TYPE_MAP.get(sheet_name.lower().strip())
        if not type_key:
            continue

        print(f"  Processing sheet: '{sheet_name}' → {type_key}")

        header_row2 = None
        for i, row in df_raw.iterrows():
            vals = [str(v).strip().lower() for v in row.values]
            if "median" in vals or "count" in vals:
                header_row2 = i
                break

        if header_row2 is None:
            print(f"    Could not find header rows — skipping")
            continue

        df = pd.read_excel(
            filepath, sheet_name=sheet_name,
            header=[header_row2 - 1, header_row2], engine=engine,
        )

        df.columns = [
            f"{str(a).strip()}_{str(b).strip()}"
            if "Unnamed" not in str(a) and str(a).strip()
            else str(b).strip()
            for a, b in df.columns
        ]
        cols = df.columns.tolist()
        df = df.dropna(how="all")

        region_col = cols[0]
        suburb_col = cols[1]
        df[region_col] = df[region_col].ffill()

        median_cols = [c for c in cols if "median" in str(c).lower()]
        if not median_cols:
            median_cols = [
                c for c in cols[2:]
                if pd.to_numeric(df[c], errors="coerce").notna().sum() > 3
            ]
        latest_col = median_cols[-1] if median_cols else None

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
                result[suburb] = {
                    "suburbs": [s.strip() for s in suburb.split("-")],
                    "region": region if region.lower() not in ("nan", "", "none") else None,
                    "period": period_end,
                    "weeklyRent": {},
                }

            if rent is not None:
                result[suburb]["weeklyRent"][type_key] = rent

    suburb_list = sorted(result.values(), key=lambda x: x["suburbs"][0])
    print(f"  Suburb groups extracted: {len(suburb_list)}")
    return suburb_list


def process_property_prices(dataset_id: str, raw_path: str) -> pd.DataFrame | None:
    """
    Download (if needed) and extract Victorian property price data for a given dataset.
    Args:
        - dataset_id (str): CKAN dataset ID (house or unit prices).
        - raw_path (str): Local path for the raw downloaded file.
    Returns:
        - pd.DataFrame | None: DataFrame with suburb and mean_price_for_period, or None on failure.
    """
    url, _name, period_end = get_latest_resource(dataset_id)
    suffix = ".xls" if url.lower().endswith(".xls") else ".xlsx"
    filepath = raw_path.replace(".xls", suffix)

    if os.path.exists(filepath):
        print(f"  Raw file already exists — skipping download: {filepath}")
    else:
        print(f"  Attempting download...")
        filepath = download_file(url, filepath, extra_headers={"Referer": "https://www.land.vic.gov.au/"})
        if not filepath:
            print(f"\n  ACTION REQUIRED — automated download blocked.")
            print(f"  1. Open this URL in your browser:\n     {url}")
            print(f"  2. Save the file as:\n     {raw_path.replace('.xls', suffix)}")
            print(f"  3. Re-run the script")
            return None

    if filepath and os.path.exists(filepath):
        _, engine = resolve_engine(filepath)
        return extract_house_prices(filepath, engine, period_end)

    return None


# =============================================================================
# CRIME — EXTRACT
# =============================================================================

def extract_lga_table(filepath: str, sheet_name: str, suburbs_by_lga: dict[str, list[dict]]) -> dict[str, dict]:
    """
    Extract LGA-level crime data including rate per 100k and Melbourne ranking.
    Expected columns: Year, Year ending, Police Region, Local Government Area,
                      Incidents Recorded, Rate per 100,000 population.
    Args:
        - filepath (str): Path to the Excel file.
        - sheet_name (str): Sheet containing LGA-level data.
    Returns:
        - dict[str, dict]: LGA name → {incidents, ratePer100k, year, melbourneRank, melbourneRankPercentile}.
    """
    print(f"\nExtracting LGA data from sheet: {sheet_name}")
    df = pd.read_excel(filepath, sheet_name=sheet_name)

    cols = df.columns.tolist()
    year_col       = cols[0]
    lga_col        = next((c for c in cols if "government area" in str(c).lower()), cols[3])
    incidents_col  = next((c for c in cols if "incidents recorded" in str(c).lower()), cols[4])
    rate_col       = next((c for c in cols if "rate" in str(c).lower() and "100" in str(c).lower()), cols[5])

    latest_year = df[year_col].dropna().max()
    df_latest = df[df[year_col] == latest_year].copy()
    print(f"  Latest year: {latest_year}, rows: {len(df_latest)}")

    result: dict[str, dict] = {}
    for _, row in df_latest.iterrows():
        lga = str(row[lga_col]).strip()
        if lga in ("nan", "", "None") or pd.isna(row.get(incidents_col)):
            continue
        result[lga] = {
            "incidents":   int(row[incidents_col]) if pd.notna(row[incidents_col]) else None,
            "ratePer100k": round(float(row[rate_col]), 1) if pd.notna(row.get(rate_col)) else None,
            "year":        str(int(latest_year)) if pd.notna(latest_year) else "unknown",
        }

    # Melbourne LGA rankings (lower rate = safer = higher percentile)
    melbourne_entries = {
        lga: data for lga, data in result.items()
        # if is_melbourne_lga(lga) and data["ratePer100k"] is not None
        if lga in suburbs_by_lga and data["ratePer100k"] is not None
    }
    sorted_melbourne = sorted(melbourne_entries.items(), key=lambda x: x[1]["ratePer100k"], reverse=True)
    total_melbourne  = len(sorted_melbourne)
    rank_lookup      = {lga: rank + 1 for rank, (lga, _) in enumerate(sorted_melbourne)}

    for lga, data in result.items():
        # if is_melbourne_lga(lga) and lga in rank_lookup:
        if lga in suburbs_by_lga and lga in rank_lookup:
            rank = rank_lookup[lga]
            data["melbourneRank"] = rank
            data["melbourneRankPercentile"] = round((1 - (rank - 1) / total_melbourne) * 100, 1)
        else:
            data["melbourneRank"] = "N/A"
            data["melbourneRankPercentile"] = "N/A"

    print(f"  LGAs extracted: {len(result)}")
    with open(OUTPUT_LGA, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"  Saved: {OUTPUT_LGA}")
    return result


def extract_suburb_table(filepath: str, sheet_name: str) -> dict[str, dict]:
    """
    Extract suburb-level crime data with total incidents and top-5 offence proportions.
    Expected columns: Year, Year ending, Police Region, Local Government Area,
                      Postcode, Suburb/Town, Offence Subgroup, Incidents Recorded.
    Args:
        - filepath (str): Path to the Excel file.
        - sheet_name (str): Sheet containing suburb-level data.
    Returns:
        - dict[str, dict]: "suburb_postcode" → {suburb, postcode, lga, totalIncidents,
          year, topFiveOffenceProportion}.
    """
    print(f"\nExtracting Suburb data from sheet: {sheet_name}")
    df = pd.read_excel(filepath, sheet_name=sheet_name)

    cols = df.columns.tolist()
    year_col           = cols[0]
    lga_col            = next((c for c in cols if "government area" in str(c).lower()), cols[2])
    postcode_col       = next((c for c in cols if "postcode" in str(c).lower()), cols[3])
    suburb_col         = next((c for c in cols if "suburb" in str(c).lower() or "town" in str(c).lower()), cols[4])
    offence_subgrp_col = next((c for c in cols if "subgroup" in str(c).lower()), cols[7])
    incidents_col      = next((c for c in cols if "incidents recorded" in str(c).lower()), cols[-1])

    latest_year = df[year_col].dropna().max()
    df_latest = df[df[year_col] == latest_year].copy()
    print(f"  Latest year: {latest_year}, rows: {len(df_latest)}")

    suburb_data: dict[str, dict] = {}
    for _, row in df_latest.iterrows():
        suburb   = str(row[suburb_col]).strip()
        postcode = str(row[postcode_col]).strip()
        lga      = str(row[lga_col]).strip()
        subgroup = str(row[offence_subgrp_col]).strip()

        if suburb in ("nan", "", "None") or postcode in ("nan", "", "None"):
            continue

        key = f"{suburb}_{postcode}"
        if key not in suburb_data:
            suburb_data[key] = {
                "suburb":         suburb,
                "postcode":       postcode,
                "lga":            lga,
                "totalIncidents": 0,
                "year":           str(int(latest_year)) if pd.notna(latest_year) else "unknown",
                "note":           "Raw count — not population normalised. Use LGA ratePer100k for scoring.",
                "_offenceSubgroups": {},
            }

        if pd.notna(row[incidents_col]):
            count = int(row[incidents_col])
            suburb_data[key]["totalIncidents"] += count
            if subgroup not in ("nan", "", "None"):
                suburb_data[key]["_offenceSubgroups"][subgroup] = (
                    suburb_data[key]["_offenceSubgroups"].get(subgroup, 0) + count
                )

    for entry in suburb_data.values():
        total    = entry["totalIncidents"]
        subgroups = entry.pop("_offenceSubgroups")
        if total > 0 and subgroups:
            top5 = sorted(subgroups.items(), key=lambda x: x[1], reverse=True)[:5]
            entry["topFiveOffenceProportion"] = {
                name: round(count / total, 4) for name, count in top5
            }
        else:
            entry["topFiveOffenceProportion"] = {}

    suburb_list = sorted(suburb_data.values(), key=lambda x: x["suburb"])
    print(f"  Suburbs extracted: {len(suburb_list)}")
    with open(OUTPUT_SUBURB, "w") as f:
        json.dump(suburb_list, f, indent=2, ensure_ascii=False)
    print(f"  Saved: {OUTPUT_SUBURB}")
    return suburb_data


# =============================================================================
# SUBURBS — EXTRACT
# =============================================================================

def fetch_melbourne_suburbs_by_lga() -> dict[str, list[dict]]:
    """
    Fetch Melbourne suburbs with postcodes grouped by LGA from the Wikipedia API.
    Parses the wikitext of "List of Melbourne suburbs" — no HTML scraping required.
    LGA names have "City of" / "Shire of" prefixes stripped to match MELBOURNE_LGAS.
    Returns:
        - dict[str, list[dict]]: LGA name → list of {suburb, postcode} dicts.
    Raises:
        - Exception: If the Wikipedia API request fails or the page is not found.
    """
    print("\nFetching Melbourne suburbs from Wikipedia API...")
    params = {
        "action":  "query",
        "titles":  "List_of_Melbourne_suburbs",
        "prop":    "revisions",
        "rvprop":  "content",
        "rvslots": "main",
        "format":  "json",
    }
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(
        f"{WIKIPEDIA_API}?{query}",
        headers={"User-Agent": "LiveOnIT/1.0 (student project) Python/3"},
    )
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read())

    pages = data["query"]["pages"]
    page = next(iter(pages.values()))
    wikitext = page["revisions"][0]["slots"]["main"]["*"]
    lines = wikitext.split("\n")
    print(f"  Page fetched — {len(lines)} lines")

    # ===[[City of Melbourne]]=== or ===[[Shire of X|Shire of X]]===
    lga_pattern    = re.compile(r"^===\[\[(?:[^\]|]+\|)?([^\]]+)\]\]===")
    # * [[Suburb, Victoria|Suburb Name]] 3053  or  * [[Suburb Name]] 3053
    suburb_pattern = re.compile(r"^\*\s+\[\[(?:[^\]|]+\|)?([^\]|]+)\]\]\s+(\d{4})")

    result: dict[str, list[dict]] = {}
    current_lga: str | None = None

    for line in lines:
        lga_match = lga_pattern.match(line.strip())
        if lga_match:
            raw = lga_match.group(1).strip()
            current_lga = re.sub(r"^(City of |Shire of )", "", raw).strip()
            if current_lga not in result:
                result[current_lga] = []
            continue

        if current_lga and line.startswith("* "):
            suburb_match = suburb_pattern.match(line)
            if suburb_match:
                suburb   = suburb_match.group(1).strip()
                postcode = suburb_match.group(2).strip()
                if not any(s["suburb"] == suburb for s in result[current_lga]):
                    result[current_lga].append({"suburb": suburb, "postcode": postcode})

    # Drop empty / non-LGA sections
    result = {k: v for k, v in result.items() if v}

    total = sum(len(v) for v in result.values())
    print(f"  {len(result)} LGAs, {total} suburbs extracted")
    with open(OUTPUT_SUBURBS_BY_LGA, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"  Saved: {OUTPUT_SUBURBS_BY_LGA}")
    return result


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":

    # -------------------------------------------------------------------------
    # HOUSING — House & Unit Prices
    # -------------------------------------------------------------------------
    for label, dataset_id, raw_path in [
        ("HOUSE PRICES", HOUSE_PRICES_DATASET, RAW_HOUSE),
        ("UNIT PRICES",  UNIT_PRICES_DATASET,  RAW_UNIT),
    ]:
        print("\n" + "=" * 60)
        print(label)
        print("=" * 60)

    try:
        house_prices = process_property_prices(HOUSE_PRICES_DATASET, RAW_HOUSE)
    except Exception as e:
        print(f"House price extraction failed: {e}")
        import traceback; traceback.print_exc()
        house_prices = None

    try:
        unit_prices = process_property_prices(UNIT_PRICES_DATASET, RAW_UNIT)
    except Exception as e:
        print(f"Unit price extraction failed: {e}")
        import traceback; traceback.print_exc()
        unit_prices = None

    if house_prices is not None and unit_prices is not None:
        merged = pd.merge(house_prices, unit_prices, on="suburb", how="outer", suffixes=("_house", "_unit"))
        merged = merged.rename(columns={
            "mean_price_for_period_house": "meanMedianHousePrice",
            "mean_price_for_period_unit":  "meanMedianUnitPrice",
        })
        # output_data = merged[["suburb", "meanMedianHousePrice", "meanMedianUnitPrice"]].to_dict(orient="records")
        # output_data = (
        #     merged[["suburb", "meanMedianHousePrice", "meanMedianUnitPrice"]]
        #     .where(merged[["suburb", "meanMedianHousePrice", "meanMedianUnitPrice"]].notna(), other=None)
        #     .to_dict(orient="records")
        # )
        output_data = merged[["suburb", "meanMedianHousePrice", "meanMedianUnitPrice"]].to_dict(orient="records")
        output_data = [
            {k: (None if isinstance(v, float) and v != v else v) for k, v in row.items()}
            for row in output_data
        ]
        with open(OUTPUT_HOUSE_UNIT, "w") as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)
        print(f"\n  Saved: {OUTPUT_HOUSE_UNIT} ({len(output_data)} suburbs)")

    # -------------------------------------------------------------------------
    # HOUSING — Rent
    # -------------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("RENTAL DATA")
    print("=" * 60)
    try:
        url, _name, period_end = get_latest_resource(RENT_DATASET)
        suffix   = ".xls" if url.lower().endswith(".xls") else ".xlsx"
        raw_path = RAW_RENT.replace(".xlsx", suffix)

        if os.path.exists(raw_path):
            print(f"  Raw file already exists — skipping download: {raw_path}")
            filepath = raw_path
        else:
            print(f"  Attempting download...")
            filepath = download_file(url, raw_path)

        if filepath and os.path.exists(filepath):
            _, engine = resolve_engine(filepath)
            rent_data = extract_rent(filepath, engine, period_end)
            with open(OUTPUT_RENT, "w") as f:
                json.dump(rent_data, f, indent=2, ensure_ascii=False)
            print(f"\n  Saved: {OUTPUT_RENT} ({len(rent_data)} suburb groups)")

    except Exception as e:
        print(f"Rental extraction failed: {e}")
        import traceback; traceback.print_exc()

    # -------------------------------------------------------------------------
    # SUBURBS
    # -------------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("SUBURB DATA")
    print("=" * 60)
    try:
        suburbs_by_lga = fetch_melbourne_suburbs_by_lga()
    except Exception as e:
        print(f"Suburb extraction failed: {e}")
        import traceback; traceback.print_exc()
        suburbs_by_lga = []

    # -------------------------------------------------------------------------
    # CRIME
    # -------------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("CRIME DATA")
    print("=" * 60)
    try:
        url, _name, _period = get_latest_resource(
            CRIME_DATASET,
            url_filter="https://files.crimestatistics.vic.gov.au",
        )

        if os.path.exists(CRIME_EXCEL):
            print(f"  Raw file already exists — skipping download: {CRIME_EXCEL}")
        else:
            filepath = download_file(url, CRIME_EXCEL)
            if not filepath:
                raise Exception("Crime data download failed.")

        _, engine  = resolve_engine(CRIME_EXCEL)
        sheet_names = inspect_sheets(CRIME_EXCEL, engine, nrows=2)

        lga_sheet    = find_sheet(sheet_names, ["Table 01", "01"])
        suburb_sheet = find_sheet(sheet_names, ["Table 03", "03"])
        print(f"\n  Using sheets: LGA={lga_sheet}, Suburb={suburb_sheet}")

        extract_lga_table(CRIME_EXCEL, lga_sheet, suburbs_by_lga)
        extract_suburb_table(CRIME_EXCEL, suburb_sheet)

    except Exception as e:
        print(f"Crime extraction failed: {e}")
        import traceback; traceback.print_exc()



    # -------------------------------------------------------------------------
    # SUMMARY
    # -------------------------------------------------------------------------
    print(f"\nOutput directories:")
    print(f"  {HOUSING_DIR}/")
    print(f"    house_unit_prices_by_suburb.json — median sale prices by suburb")
    print(f"    rent_by_suburb.json              — median weekly rent by suburb group")
    print(f"    raw/                             — raw downloaded files")
    print(f"  {CRIME_DIR}/")
    print(f"    crime_by_lga.json                — LGA incidents + rate per 100k")
    print(f"    crime_by_suburb.json             — suburb incidents (raw count)")
    print(f"  {SUBURB_DIR}/")
    print(f"    melbourne_suburbs_by_lga.json    — suburb + postcode list per LGA")
    print(f"\nNote: Data is published quarterly. Re-run each quarter for latest data.")
    print(f"      Delete raw files to force re-download.")
