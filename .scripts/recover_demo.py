import ast
import numpy as np
import pandas as pd
import os
from tqdm import tqdm
import ast

# All answers
print("=" * 80)
print("LOADING ANSWERS\n")
base_path = "../answers"

# Get the name of all files in the directory
files = filter(lambda s: s.endswith(".csv"), sorted(os.listdir(base_path)))
files = list(map(lambda s: os.path.join(base_path, s), files))
print("Information about survey answers are in the following files:")
for file in files:
    print("  -", file)

df_answers = pd.concat([pd.read_csv(f) for f in files])
df_answers["createdAt"] = pd.to_datetime(df_answers["createdAt"])

print("\nSummary")
print(f"- Raw number of answers: {df_answers.shape[0]:,}")
print(f"- Number of unique session IDs: {df_answers['sessionId'].unique().shape[0]:,}")

print("\n")

# Individual data
print("=" * 80)
print("LOADING INDIVIDUALS' DATA\n")
base_path = "../individuals"

# Get the name of all files in the directory
files = filter(lambda s: s.endswith(".csv"), sorted(os.listdir(base_path)))
files = list(map(lambda s: os.path.join(base_path, s), files))
print("Information about survey respondents are in the following files:")
for file in files:
    print("  -", file)

df_individuals = pd.concat([pd.read_csv(f) for f in files])
df_individuals["createdAt"] = pd.to_datetime(df_individuals["createdAt"])

print("\nSummary")
print(f"- Raw number of rows: {df_individuals.shape[0]:,}")
print("\nNumber of unique session IDs")
print(
    f" - CRT: {df_individuals[df_individuals['informationType'] == 'CRT'].shape[0]:,}"
)
print(
    f" - RME: {df_individuals[df_individuals['informationType'] == 'rmeTen'].shape[0]:,}"
)
print(
    f" - Demo: {df_individuals[(df_individuals['informationType'] == 'demographics')
                                 | (df_individuals['informationType'] == 'demographicsLongInternational')].shape[0]:,}"
)

print("\n")

# Process sessions
print("=" * 80)
print("PROCESSING SESSIONS\n")

print("Only keep sessions that have at least 5 answers")

# Number of individuals
# (Each individual is identified by a unique sessionId)
gb = df_answers.groupby("sessionId")
# Count how many answers each individual gave
gb_counts = gb.count().iloc[:, 1]
# Only keep individuals who answered at least 15 questions
gb_counts = gb_counts[gb_counts >= 5]

df_answers = df_answers[df_answers["sessionId"].isin(gb_counts.index)]
print(f"Total number of answers after filtering: {df_answers.shape[0]:,}")

print()
print(
    "For all answers with the same session ID, keep only the last answer using createdAt"
)

# df_answers_last now contains only the sessions with at least 15 answers and their last answer
df_answers_last = df_answers.sort_values("createdAt").drop_duplicates(
    subset=["sessionId"], keep="last"
)
df_answers_last.set_index("sessionId", inplace=True)
print(f"Number of unique session IDs from answers: {df_answers_last.shape[0]:,}")

print()
print("Create a 'startAt' column using createdAt and secondsElapsed")

# startAt
df_individuals["secondsElapsed"] = df_individuals["experimentInfo"].map(
    lambda x: ast.literal_eval(x)["secondsElapsed"]
)

df_individuals["startAt"] = df_individuals["createdAt"] - pd.to_timedelta(
    df_individuals["secondsElapsed"], unit="s"
)

print()
print("Split the individuals dataframe into CRT, RME and Demographic dataframes")

df_individuals_crt = df_individuals[df_individuals["informationType"] == "CRT"].copy(
    deep=True
)
df_individuals_rme = df_individuals[df_individuals["informationType"] == "rmeTen"].copy(
    deep=True
)
df_individuals_demo = df_individuals[
    (df_individuals["informationType"] == "demographics")
    | (df_individuals["informationType"] == "demographicsLongInternational")
].copy(deep=True)

for df in [df_individuals_crt, df_individuals_rme, df_individuals_demo]:

    # If there are duplicates of one session ID, only keep the record with the
    # latest createdAt value
    df.sort_values("createdAt", inplace=True)

    df.drop_duplicates(subset=["userSessionId"], keep="last", inplace=True)

    df.dropna(subset=["userSessionId"], inplace=True)
    df["userSessionId"] = df["userSessionId"].astype(str)

    df.set_index("userSessionId", inplace=True)

unique_session_ids = {
    "ratings": df_answers_last.index.unique(),
    "crt": df_individuals_crt.index.unique(),
    "rme": df_individuals_rme.index.unique(),
    "demo": df_individuals_demo.index.unique(),
}

print("Number of unique session IDs for each information type:")
for key, value in unique_session_ids.items():
    print(f"- {key.upper()}: {len(value):,}")

print()
# User IDs common to all four information types
common_session_ids = (
    set(unique_session_ids["crt"])
    & set(unique_session_ids["rme"])
    & set(unique_session_ids["demo"])
    & set(unique_session_ids["ratings"])
)
print(
    f"Number of user IDs common to all four information types: {len(common_session_ids):,}"
)

# Match CRT, RME and Demographic records
print("=" * 80)
print("MATCHING CRT, RME AND DEMOGRAPHIC TRIPLES\n")


def find_closest_triplets(
    df_individuals_crt_rem,
    df_individuals_rme_rem,
    df_individuals_demo_rem,
    threshold=1.5,
):

    # Matching results. Note that the smallest collection is the demographics
    # because it was collected last. Thus, the maximum number of matches we
    # can reconstruct is as large as the number of demographic records.
    triplet_match_results = pd.DataFrame(
        index=df_individuals_demo_rem.index,
        columns=[
            "num-crt-matches",
            "crt",
            "diff-crt",
            "num-rme-matches",
            "rme",
            "diff-rme",
        ],
    )
    triplet_match_results.index.name = "demo"

    for demo_id in tqdm(
        triplet_match_results.index,
    ):
        demo_start_time = df_individuals_demo.loc[demo_id, "startAt"]

        # Find the index of the closest record, but this record must also be within
        # the threshold of 1.5 seconds. If we can't find any, then it's empty.
        diff_demo_crt = (demo_start_time - df_individuals_crt_rem["startAt"]).abs()
        diff_demo_threshold = diff_demo_crt[
            diff_demo_crt <= pd.Timedelta(seconds=threshold)
        ]
        diff_demo_rme = (demo_start_time - df_individuals_rme_rem["startAt"]).abs()
        diff_demo_rme_threshold = diff_demo_rme[
            diff_demo_rme <= pd.Timedelta(seconds=threshold)
        ]

        triplet_match_results.at[demo_id, "num-crt-matches"] = (
            diff_demo_threshold.shape[0]
        )
        triplet_match_results.at[demo_id, "num-rme-matches"] = (
            diff_demo_rme_threshold.shape[0]
        )

        triplet_match_results.at[demo_id, "crt"] = diff_demo_crt.idxmin()
        triplet_match_results.at[demo_id, "diff-crt"] = (
            diff_demo_crt.min().total_seconds()
        )
        triplet_match_results.at[demo_id, "rme"] = diff_demo_rme.idxmin()
        triplet_match_results.at[demo_id, "diff-rme"] = (
            diff_demo_rme.min().total_seconds()
        )

    # Only retain triplet for which we have at least one match for CRT and RME
    triplet_only_one = triplet_match_results[
        (triplet_match_results["num-crt-matches"] >= 1)
        & (triplet_match_results["num-rme-matches"] >= 1)
    ]

    # There can be a CRT record that is the closest to two Demo records.
    # In this casem we deduplicate by keeping the one with the smallest time difference. Same for RME.
    triplet_only_one_dedup = (
        triplet_only_one.sort_values(by="diff-crt")
        .groupby("crt")
        .nth(0)
        .sort_values(by="diff-rme")
        .groupby("rme")
        .nth(0)
    )

    return triplet_only_one_dedup.reset_index(drop=False)


# Final results
triplet_results_all = None

# Start with the set of session IDs that are common to all
# 4 collections. They don't need any matching.
processed_crt_ids = common_session_ids.copy()
processed_rme_ids = common_session_ids.copy()
processed_demo_ids = common_session_ids.copy()

for i in range(1, 100):
    print(f"Iteration {i}...")

    # Remaining records. Starting with the records that are NOT common
    # in all four datasets
    df_individuals_crt_rem = df_individuals_crt.drop(index=processed_crt_ids)
    df_individuals_rme_rem = df_individuals_rme.drop(index=processed_rme_ids)
    df_individuals_demo_rem = df_individuals_demo.drop(index=processed_demo_ids)
    triplet_results = find_closest_triplets(
        df_individuals_crt_rem,
        df_individuals_rme_rem,
        df_individuals_demo_rem,
        threshold=1.5,
    )

    triplet_results["iter"] = i
    triplet_results = triplet_results[
        [
            "crt",
            "rme",
            "demo",
            "iter",
            "diff-crt",
            "num-crt-matches",
            "diff-rme",
            "num-rme-matches",
        ]
    ]

    # Only keep triplets where there is exactly one match for CRT and RME
    # triplet_results = triplet_results[(triplet_results["num-crt-matches"] == 1) & (triplet_results["num-rme-matches"] == 1)]

    print(f"Number of triplets found in this iteration: {triplet_results.shape[0]:,}")

    if triplet_results.shape[0] == 0:
        print("No more triplets found.")
        break
    if triplet_results_all is None:
        triplet_results_all = triplet_results.copy()
    else:
        triplet_results_all = pd.concat(
            [triplet_results_all, triplet_results], axis=0
        ).reset_index(drop=True)

    processed_crt_ids.update(triplet_results["crt"])
    processed_rme_ids.update(triplet_results["rme"])
    processed_demo_ids.update(triplet_results["demo"])
    print(f"Total number of triplets found: {triplet_results.shape[0]:,}")

# Number of triplets for which there is exactly one match for CRT and RME
print()
print(f"Total number of triplets found: {triplet_results_all.shape[0]:,}")

print()
print(
    "Number of triplets for which there is exactly one match for CRT and RME:"
    f" {triplet_results_all[(triplet_results_all['num-crt-matches'] == 1)
                              & (triplet_results_all['num-rme-matches'] == 1)].shape[0]:,}"
)

print()
triplet_path = "../demo_matches/triplet_results_highconf.csv"
print(f"Saving the triplets to {triplet_path}")
triplet_results_all.to_csv(triplet_path)

# Match triples with ratings
print("=" * 80)
print("MATCHING CRT, RME AND DEMOGRAPHIC TRIPLES WITH RATINGS\n")

triplet_results_all["crt_created"] = df_individuals_crt.loc[
    triplet_results_all["crt"], "createdAt"
].values
triplet_results_all["crt_started"] = df_individuals_crt.loc[
    triplet_results_all["crt"], "startAt"
].values

triplet_results_all["rme_created"] = df_individuals_rme.loc[
    triplet_results_all["rme"], "createdAt"
].values
triplet_results_all["rme_started"] = df_individuals_rme.loc[
    triplet_results_all["rme"], "startAt"
].values

triplet_results_all["demo_created"] = df_individuals_demo.loc[
    triplet_results_all["demo"], "createdAt"
].values
triplet_results_all["demo_started"] = df_individuals_demo.loc[
    triplet_results_all["demo"], "startAt"
].values

THRESHOLD = 1.5
df_answers_last_rem = df_answers_last.drop(index=common_session_ids)

# Results
triplets_plus_answers = None

# Initialize with "NO MATCH", meaning these triplets do not have a match yet
triplet_results_all["answers"] = "NO MATCH"
triplet_results_all.at[i, "diff-answers"] = np.nan
triplet_results_all["round"] = np.nan

answers_already_used = set(common_session_ids)

for round_number in range(1, 101):
    # Find the remaining triplets that do not have a match yet
    if triplets_plus_answers is None:
        remaining_triplets = triplet_results_all.copy()
    else:
        remaining_triplets = triplet_results_all[
            ~triplet_results_all["crt"].isin(triplets_plus_answers["crt"])
        ].copy()

    print(f"Round {round_number}: {remaining_triplets.shape[0]:,} remaining triplets")

    num_matches_this_round = 0

    for i, row in tqdm(
        remaining_triplets.iterrows(), total=remaining_triplets.shape[0]
    ):
        # Compare CRT start time with the creation time of the last answer.
        # Eligible differences must be within the threshold.
        crt_start_time = row["crt_started"]
        rme_start_time = row["rme_started"]
        demo_start_time = row["demo_started"]

        time_diff_crt = (crt_start_time - df_answers_last_rem["createdAt"]).abs()
        time_diff_rme = (rme_start_time - df_answers_last_rem["createdAt"]).abs()
        time_diff_demo = (demo_start_time - df_answers_last_rem["createdAt"]).abs()

        # Element-wise min
        time_diff = pd.concat(
            [time_diff_crt, time_diff_rme, time_diff_demo], axis=1
        ).min(axis=1)

        # Don't use answers that have already been matched
        time_diff = time_diff[~time_diff.index.isin(answers_already_used)]

        # Restrict to the threshold
        time_diff = time_diff[time_diff <= pd.Timedelta(seconds=THRESHOLD)]

        remaining_triplets.at[i, "num-answers-matches"] = time_diff.shape[0]
        if time_diff.shape[0] > 0:
            remaining_triplets.at[i, "answers"] = time_diff.idxmin()
            remaining_triplets.at[i, "diff-answers"] = time_diff.min().total_seconds()
            num_matches_this_round += 1

    print(f" - Number of matches in this round: {num_matches_this_round}")
    if num_matches_this_round == 0:
        print("No more matches found. Stopping.")
        break

    # Deduplicate record with the same answer
    remaining_triplets = remaining_triplets[remaining_triplets["answers"] != "NO MATCH"]
    remaining_triplets = (
        remaining_triplets.sort_values(by="diff-answers")
        .groupby("answers")
        .nth(0)
        .reset_index(drop=False)
    )

    print(" - Number of matches after deduplication:", remaining_triplets.shape[0])

    # Add to final results
    if triplets_plus_answers is None:
        triplets_plus_answers = remaining_triplets.copy()
    else:
        triplets_plus_answers = pd.concat(
            [triplets_plus_answers, remaining_triplets], axis=0
        ).reset_index(drop=True)

    answers_already_used.update(remaining_triplets["answers"].values)

    print(f" - Total number of matches so far: {triplets_plus_answers.shape[0]}")

print()
print(
    f"Total number of complete (answer-CRT-RME-Demo) matches: {triplets_plus_answers.shape[0]:,}"
)


# Add the all-4 data in
print("=" * 80)
print("MATCHING CRT, RME AND DEMOGRAPHIC TRIPLES\n")

# Add the common session IDs to the triplet results
for session_id in tqdm(
    common_session_ids, desc="Processing common sessions", unit=" sessions", leave=True
):
    answer = df_answers_last.loc[session_id]
    crt = df_individuals_crt.loc[session_id]
    rme = df_individuals_rme.loc[session_id]
    demo = df_individuals_demo.loc[session_id]

    row = pd.Series(
        {
            "answers": session_id,
            "crt": crt.name,
            "rme": rme.name,
            "demo": demo.name,
            "crt_diff": (crt["startAt"] - answer["createdAt"]).total_seconds(),
            "rme_diff": (rme["startAt"] - answer["createdAt"]).total_seconds(),
            "demo_diff": (demo["startAt"] - answer["createdAt"]).total_seconds(),
            "method": "all_4",
        }
    )
    triplets_plus_answers = pd.concat(
        [triplets_plus_answers, row.to_frame().T], ignore_index=True
    )

triplets_plus_answers_path = "../demo_matches/triplet_results_plus_answer.csv"
print(f"Saving triplet results with answers to: {triplets_plus_answers_path}")
triplets_plus_answers.to_csv(triplets_plus_answers_path, index=False)
