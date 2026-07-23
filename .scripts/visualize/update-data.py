import json
import os

import pandas as pd

if not os.path.exists("data"):
    os.makedirs("data")


def _read_csvs(base_path):
    files = sorted(f for f in os.listdir(base_path) if f.endswith(".csv"))
    return pd.concat(
        [pd.read_csv(os.path.join(base_path, f)) for f in files],
        ignore_index=True,
    )


def _prep_individuals(df, info_types):
    """Filter to the given informationType(s), deduplicate (keep last per
    session), drop nulls, and index by userSessionId."""
    out = df[df["informationType"].isin(info_types)].copy()
    out.sort_values("createdAt", inplace=True)
    out.drop_duplicates(subset=["userSessionId"], keep="last", inplace=True)
    out.dropna(subset=["userSessionId"], inplace=True)
    out["userSessionId"] = out["userSessionId"].astype(str)
    return out.set_index("userSessionId")


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
df_answers.rename(columns={"sessionId": "userSessionId"}, inplace=True)
df_answers["createdAt"] = pd.to_datetime(df_answers["createdAt"])

df_answers = df_answers[
    ["userSessionId", "statementId", "I_agree", "others_agree", "createdAt"]
]
df_answers.sort_values("createdAt", inplace=True)
df_answers.drop_duplicates(
    subset=["userSessionId", "statementId"], keep="last", inplace=True
)
# df_answers.drop(columns=["createdAt"], inplace=True)

# Sessions with consistent IDs across all sources (pre-bug / post-bug cohort):
# must have the same userSessionId appearing as the answers, CRT, RME, and demo ID.
common_ids = (
    set(df_crt.index)
    & set(df_rme.index)
    & set(df_demo.index)
    & set(df_answers["userSessionId"])
)

# Sanity check: make sure that common_ids do not overlap with any IDs used in the Hungarian matches (in any role)
assert common_ids.isdisjoint(
    set(df_matched_hungarian.index)
), "Common IDs overlap with userSessionIds used in Hungarian matches"
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
# # the same userSessionId appears as the answers, CRT, RME, and demo ID.
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
    index=pd.Index(common_ids, name="userSessionId"),
)

df_matched_all = pd.concat([df_matched_hungarian, df_common])

print(f"Number of users: {len(df_matched_all):,}")
print(f"  via Hungarian matching : {len(df_matched_hungarian):,}")
print(f"  via consistent ID      : {len(df_common):,}")


df_answers = df_answers[df_answers["userSessionId"].isin(df_matched_all.index)].copy()
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

df_collated.index.name = "userSessionId"

df_collated.to_csv("data/crt_rme_demo.csv")
print("\nSaved collated CRT/RME/Demo data to data/crt_rme_demo.csv")
