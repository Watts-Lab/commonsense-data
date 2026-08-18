import json
import os
import re

import pandas as pd

if not os.path.exists("data"):
    os.makedirs("data")

# ISO 3166-1 numeric code -> country name, aligned with the country_reside naming
# convention already used in individuals/*.csv demographics (e.g. "Turkey" not
# "Türkiye", "Korea, South" not "Korea, Republic of"). Used to resolve the c_code /
# tc query params Besample appends to a participant's recruitment link.
ISO_NUMERIC_TO_COUNTRY = {
    "004": "Afghanistan",
    "008": "Albania",
    "010": "Antarctica",
    "012": "Algeria",
    "016": "American Samoa",
    "020": "Andorra",
    "024": "Angola",
    "028": "Antigua and Barbuda",
    "031": "Azerbaijan",
    "032": "Argentina",
    "036": "Australia",
    "040": "Austria",
    "044": "Bahamas",
    "048": "Bahrain",
    "050": "Bangladesh",
    "051": "Armenia",
    "052": "Barbados",
    "056": "Belgium",
    "060": "Bermuda",
    "064": "Bhutan",
    "068": "Bolivia",
    "070": "Bosnia and Herzegovina",
    "072": "Botswana",
    "074": "Bouvet Island",
    "076": "Brazil",
    "084": "Belize",
    "086": "British Indian Ocean Territory",
    "090": "Solomon Islands",
    "092": "Virgin Islands, British",
    "096": "Brunei Darussalam",
    "100": "Bulgaria",
    "104": "Myanmar (Burma)",
    "108": "Burundi",
    "112": "Belarus",
    "116": "Cambodia",
    "120": "Cameroon",
    "124": "Canada",
    "132": "Cabo Verde",
    "136": "Cayman Islands",
    "140": "Central African Republic",
    "144": "Sri Lanka",
    "148": "Chad",
    "152": "Chile",
    "156": "China",
    "158": "Taiwan",
    "162": "Christmas Island",
    "166": "Cocos (Keeling) Islands",
    "170": "Colombia",
    "174": "Comoros",
    "175": "Mayotte",
    "178": "Congo",
    "180": "Congo, The Democratic Republic of the",
    "184": "Cook Islands",
    "188": "Costa Rica",
    "191": "Croatia",
    "192": "Cuba",
    "196": "Cyprus",
    "203": "Czechia",
    "204": "Benin",
    "208": "Denmark",
    "212": "Dominica",
    "214": "Dominican Republic",
    "218": "Ecuador",
    "222": "El Salvador",
    "226": "Equatorial Guinea",
    "231": "Ethiopia",
    "232": "Eritrea",
    "233": "Estonia",
    "234": "Faroe Islands",
    "238": "Falkland Islands (Malvinas)",
    "239": "South Georgia and the South Sandwich Islands",
    "242": "Fiji",
    "246": "Finland",
    "248": "Åland Islands",
    "250": "France",
    "254": "French Guiana",
    "258": "French Polynesia",
    "260": "French Southern Territories",
    "262": "Djibouti",
    "266": "Gabon",
    "268": "Georgia",
    "270": "Gambia",
    "275": "Palestine, State of",
    "276": "Germany",
    "288": "Ghana",
    "292": "Gibraltar",
    "296": "Kiribati",
    "300": "Greece",
    "304": "Greenland",
    "308": "Grenada",
    "312": "Guadeloupe",
    "316": "Guam",
    "320": "Guatemala",
    "324": "Guinea",
    "328": "Guyana",
    "332": "Haiti",
    "334": "Heard Island and McDonald Islands",
    "336": "Vatican City",
    "340": "Honduras",
    "344": "Hong Kong",
    "348": "Hungary",
    "352": "Iceland",
    "356": "India",
    "360": "Indonesia",
    "364": "Iran",
    "368": "Iraq",
    "372": "Ireland",
    "376": "Israel",
    "380": "Italy",
    "384": "Côte d'Ivoire",
    "388": "Jamaica",
    "392": "Japan",
    "398": "Kazakhstan",
    "400": "Jordan",
    "404": "Kenya",
    "408": "Korea, North",
    "410": "Korea, South",
    "414": "Kuwait",
    "417": "Kyrgyzstan",
    "418": "Laos",
    "422": "Lebanon",
    "426": "Lesotho",
    "428": "Latvia",
    "430": "Liberia",
    "434": "Libya",
    "438": "Liechtenstein",
    "440": "Lithuania",
    "442": "Luxembourg",
    "446": "Macao",
    "450": "Madagascar",
    "454": "Malawi",
    "458": "Malaysia",
    "462": "Maldives",
    "466": "Mali",
    "470": "Malta",
    "474": "Martinique",
    "478": "Mauritania",
    "480": "Mauritius",
    "484": "Mexico",
    "492": "Monaco",
    "496": "Mongolia",
    "498": "Moldova",
    "499": "Montenegro",
    "500": "Montserrat",
    "504": "Morocco",
    "508": "Mozambique",
    "512": "Oman",
    "516": "Namibia",
    "520": "Nauru",
    "524": "Nepal",
    "528": "Netherlands",
    "531": "Curaçao",
    "533": "Aruba",
    "534": "Sint Maarten (Dutch part)",
    "535": "Bonaire, Sint Eustatius and Saba",
    "540": "New Caledonia",
    "548": "Vanuatu",
    "554": "New Zealand",
    "558": "Nicaragua",
    "562": "Niger",
    "566": "Nigeria",
    "570": "Niue",
    "574": "Norfolk Island",
    "578": "Norway",
    "580": "Northern Mariana Islands",
    "581": "United States Minor Outlying Islands",
    "583": "Micronesia",
    "584": "Marshall Islands",
    "585": "Palau",
    "586": "Pakistan",
    "591": "Panama",
    "598": "Papua New Guinea",
    "600": "Paraguay",
    "604": "Peru",
    "608": "Philippines",
    "612": "Pitcairn",
    "616": "Poland",
    "620": "Portugal",
    "624": "Guinea-Bissau",
    "626": "Timor-Leste",
    "630": "Puerto Rico",
    "634": "Qatar",
    "638": "Réunion",
    "642": "Romania",
    "643": "Russia",
    "646": "Rwanda",
    "652": "Saint Barthélemy",
    "654": "Saint Helena, Ascension and Tristan da Cunha",
    "659": "Saint Kitts and Nevis",
    "660": "Anguilla",
    "662": "Saint Lucia",
    "663": "Saint Martin (French part)",
    "666": "Saint Pierre and Miquelon",
    "670": "Saint Vincent and the Grenadines",
    "674": "San Marino",
    "678": "Sao Tome and Principe",
    "682": "Saudi Arabia",
    "686": "Senegal",
    "688": "Serbia",
    "690": "Seychelles",
    "694": "Sierra Leone",
    "702": "Singapore",
    "703": "Slovakia",
    "704": "Vietnam",
    "705": "Slovenia",
    "706": "Somalia",
    "710": "South Africa",
    "716": "Zimbabwe",
    "724": "Spain",
    "728": "South Sudan",
    "729": "Sudan",
    "732": "Western Sahara",
    "740": "Suriname",
    "744": "Svalbard and Jan Mayen",
    "748": "Eswatini",
    "752": "Sweden",
    "756": "Switzerland",
    "760": "Syria",
    "762": "Tajikistan",
    "764": "Thailand",
    "768": "Togo",
    "772": "Tokelau",
    "776": "Tonga",
    "780": "Trinidad and Tobago",
    "784": "United Arab Emirates",
    "788": "Tunisia",
    "792": "Turkey",
    "795": "Turkmenistan",
    "796": "Turks and Caicos Islands",
    "798": "Tuvalu",
    "800": "Uganda",
    "804": "Ukraine",
    "807": "North Macedonia (formerly Macedonia)",
    "818": "Egypt",
    "826": "United Kingdom",
    "831": "Guernsey",
    "832": "Jersey",
    "833": "Isle of Man",
    "834": "Tanzania",
    "840": "United States",
    "850": "Virgin Islands, U.S.",
    "854": "Burkina Faso",
    "858": "Uruguay",
    "860": "Uzbekistan",
    "862": "Venezuela",
    "876": "Wallis and Futuna",
    "882": "Samoa",
    "887": "Yemen",
    "894": "Zambia",
}

# Matches the c_code or tc key inside a urlParams string such as
# '{assignment_id:"...",c_code:"818",g_code:"null",language:"en",response_id:"..."}'.
# The (?:^|[{,]) guard ensures we match the *key* c_code/tc exactly, not any
# substring match inside an unrelated value (e.g. an fbclid token happens to
# contain the two characters "tc").
_URL_PARAM_COUNTRY_CODE_RE = re.compile(r'(?:^|[{,])(?:c_code|tc):"([^"]*)"')


def _extract_country_code(url_params):
    """Pull the Besample ISO 3166-1 numeric country code out of a urlParams
    string, if present. Returns None if urlParams is empty/missing or does not
    contain a c_code / tc key."""
    if not isinstance(url_params, str) or url_params.strip() in ("", "{}"):
        return None
    match = _URL_PARAM_COUNTRY_CODE_RE.search(url_params)
    return match.group(1) if match else None


def _code_to_country(code):
    """Map an ISO 3166-1 numeric code (e.g. '818', '76') to a country name in
    our naming convention. Returns None if the code isn't a recognized country
    (e.g. Besample's placeholder code '999')."""
    return ISO_NUMERIC_TO_COUNTRY.get(str(code).zfill(3))


def _read_csvs(base_path):
    files = sorted(f for f in os.listdir(base_path) if f.endswith(".csv"))
    return pd.concat(
        [pd.read_csv(os.path.join(base_path, f)) for f in files],
        ignore_index=True,
    )


def _prep_individuals(df, info_types):
    """Filter to the given informationType(s), deduplicate (keep last per
    session), drop nulls, and index by sessionId."""
    out = df[df["informationType"].isin(info_types)].copy()
    out.sort_values("createdAt", inplace=True)
    out.drop_duplicates(subset=["sessionId"], keep="last", inplace=True)
    out.dropna(subset=["sessionId"], inplace=True)
    out["sessionId"] = out["sessionId"].astype(str)
    return out.set_index("sessionId")


print("=" * 80)
print("\nReading matched user records...")

# Bug-affected sessions recovered by the Hungarian matching algorithm
df_matched_hungarian = pd.read_csv(
    "../../demo_matches/all_matches_hungarian.csv", index_col="answers"
)

print("\n" + "=" * 80)
print("\nReading user data...")

df_ind = _read_csvs("../../individuals")
df_ind["createdAt"] = pd.to_datetime(df_ind["createdAt"])

df_crt = _prep_individuals(df_ind, ["CRT"])
df_rme = _prep_individuals(df_ind, ["rmeTen"])
df_demo = _prep_individuals(df_ind, ["demographics", "demographicsLongInternational"])
del df_ind

print("\n" + "=" * 80)
print("\nReading answers...")

df_answers = _read_csvs("../../answers")
df_answers.rename(columns={"sessionId": "sessionId"}, inplace=True)
df_answers["createdAt"] = pd.to_datetime(df_answers["createdAt"])

df_answers = df_answers[
    ["sessionId", "statementId", "I_agree", "others_agree", "createdAt"]
]
df_answers.sort_values("createdAt", inplace=True)
df_answers.drop_duplicates(
    subset=["sessionId", "statementId"], keep="last", inplace=True
)
# df_answers.drop(columns=["createdAt"], inplace=True)

# Sessions with consistent IDs across all sources (pre-bug / post-bug cohort):
# must have the same sessionId appearing as the answers, CRT, RME, and demo ID.
common_ids = (
    set(df_crt.index)
    & set(df_rme.index)
    & set(df_demo.index)
    & set(df_answers["sessionId"])
)

# Sanity check: make sure that common_ids do not overlap with any IDs used in the Hungarian matches (in any role)
assert common_ids.isdisjoint(
    set(df_matched_hungarian.index)
), "Common IDs overlap with sessionIds used in Hungarian matches"
assert common_ids.isdisjoint(
    set(df_matched_hungarian["crt"])
), "Common IDs overlap with CRT IDs used in Hungarian matches"
assert common_ids.isdisjoint(
    set(df_matched_hungarian["rme"])
), "Common IDs overlap with RME IDs used in Hungarian matches"
assert common_ids.isdisjoint(
    set(df_matched_hungarian["demo"])
), "Common IDs overlap with demo IDs used in Hungarian matches"


# # Sessions with consistent IDs across all sources (pre-bug / post-bug cohort):
# # the same sessionId appears as the answers, CRT, RME, and demo ID.
# # Derived as the intersection of CRT/RME/demo indices, minus every ID already
# # consumed by the Hungarian algorithm in any role (answers, CRT, RME, or demo).
# # Subtracting only the answers IDs is not sufficient: a CRT/RME/demo ID used
# # in a Hungarian match could coincidentally appear in the intersection and be
# # assigned a second time as a "common" session, producing duplicate records.
# hungarian_used_ids = (
#     set(df_matched_hungarian.index)          # answers IDs
#     | set(df_matched_hungarian["crt"])
#     | set(df_matched_hungarian["rme"])
#     | set(df_matched_hungarian["demo"])
# )
# common_ids = (
#     set(df_crt.index) & set(df_rme.index) & set(df_demo.index)
# ) - hungarian_used_ids

# df_common = pd.DataFrame(
#     {"crt": list(common_ids), "rme": list(common_ids), "demo": list(common_ids)},
#     index=pd.Index(list(common_ids), name="answers"),
# )

common_ids = sorted(common_ids)  # sort for reproducibility
df_common = pd.DataFrame(
    {"crt": common_ids, "rme": common_ids, "demo": common_ids},
    index=pd.Index(common_ids, name="sessionId"),
)

df_matched_all = pd.concat([df_matched_hungarian, df_common])

print(f"Number of users: {len(df_matched_all):,}")
print(f"  via Hungarian matching : {len(df_matched_hungarian):,}")
print(f"  via consistent ID      : {len(df_common):,}")


df_answers = df_answers[df_answers["sessionId"].isin(df_matched_all.index)].copy()
print(f"Number of answers for {len(df_matched_all):,} users: {len(df_answers):,}")

print(df_answers.columns)
df_answers.to_csv("data/answers.csv", index=False)
print("\nSaved answers to data/answers.csv")

print("\n" + "=" * 80)

# Filter individual records to matched sessions only
df_crt = df_crt[df_crt.index.isin(df_matched_all["crt"])].copy()
df_rme = df_rme[df_rme.index.isin(df_matched_all["rme"])].copy()
df_demo = df_demo[df_demo.index.isin(df_matched_all["demo"])].copy()

print(f"Number of CRT  records: {len(df_crt):,}")
print(f"Number of RME  records: {len(df_rme):,}")
print(f"Number of Demo records: {len(df_demo):,}")

df_crt["crt_score"] = df_crt["experimentInfo"].map(
    lambda x: json.loads(x)["result"]["score"]
)

df_rme["rme_score"] = df_rme["experimentInfo"].map(
    lambda x: json.loads(x)["result"]["score"]
)

df_demo["country_reside"] = df_demo["experimentInfo"].map(
    lambda x: json.loads(x)["responses"]["country_reside"]
)

# Collate crt, rme and demo into columns
df_collated = pd.DataFrame(index=df_matched_all.index)

matched_crt = df_crt.loc[df_matched_all.loc[df_collated.index, "crt"], "crt_score"]
df_collated["matched_crt_id"] = matched_crt.index
df_collated["crt"] = matched_crt.values

matched_rme = df_rme.loc[df_matched_all.loc[df_collated.index, "rme"], "rme_score"]
df_collated["matched_rme_id"] = matched_rme.index
df_collated["rme"] = matched_rme.values

matched_demo = df_demo.loc[
    df_matched_all.loc[df_collated.index, "demo"], "country_reside"
]
df_collated["matched_demo_id"] = matched_demo.index
df_collated["country_reside"] = matched_demo.values

df_collated.index.name = "sessionId"

print("\n" + "=" * 80)
print("\nReading experiment records (for Besample-recruited country overrides)...")

df_exp = _read_csvs("../../experiments")
df_exp["sessionId"] = df_exp["sessionId"].astype(str)
df_exp["_country_code"] = df_exp["urlParams"].map(_extract_country_code)

# One code per session. In practice urlParams is constant across all of a
# session's experiment rows, but guard against inconsistency by just keeping
# the first non-null code found.
besample_codes = (
    df_exp.dropna(subset=["_country_code"])
    .drop_duplicates(subset=["sessionId"], keep="first")
    .set_index("sessionId")["_country_code"]
)

besample_country = besample_codes.reindex(df_collated.index).map(
    lambda code: _code_to_country(code) if pd.notna(code) else None
)
override_mask = besample_country.notna()

print(
    f"\n{override_mask.sum():,} participants have a Besample recruitment code "
    "(c_code/tc) mapping to a known country — overriding their self-reported "
    "country_reside with it:"
)
if override_mask.any():
    comparison = pd.DataFrame(
        {
            "self_reported": df_collated.loc[override_mask, "country_reside"],
            "besample_country": besample_country[override_mask],
        }
    )
    comparison["matched_self_report"] = (
        comparison["self_reported"] == comparison["besample_country"]
    )
    print(comparison.to_string())
    print(
        f"\n  {comparison['matched_self_report'].sum():,} matched their self-report, "
        f"{(~comparison['matched_self_report']).sum():,} did not (overwritten)."
    )

df_collated.loc[override_mask, "country_reside"] = besample_country[override_mask]

df_collated.to_csv("data/crt_rme_demo.csv")
print("\nSaved collated CRT/RME/Demo data to data/crt_rme_demo.csv")
