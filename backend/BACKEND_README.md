# BACKEND INSTRUCTIONS
1. python installs required [pandas openpyxl]
2. run python extract_data.py it will fail to extract the house price and unit price files but will tell you what to download and what to rename then you put them in backend/housing_data/raw. This wont be required if you pull the files [house_prices_raw, unit_prices_raw] from the repo. The rest should download themselves via url/api.
3. run python join_open_data which will generate files melbourne_housing_crime_data in json and csv format (note some columns removed from csv for practicality)
4. scoring fields to be used in future score calculation are "robust z-score (MAD)" which are improved on earlier ranking and percentile attempts.