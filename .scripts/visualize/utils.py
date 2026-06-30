import pandas as pd
import numpy as np


def individual_commonsensicality(
    target_ratings: pd.DataFrame,
    reference_ratings: pd.DataFrame,
    min_ratings_per_statement: int = 10,
    min_statements_per_user: int = 5,
) -> pd.DataFrame:
    """Compute individual commonsensicality score for each user in target_ratings, statement ratings in reference_ratings.

    Args:
        target_ratings (pd.DataFrame): A DataFrame with columns ["userSessionId", "statementId", "I_agree", "others_agree"] containing the ratings for which to compute commonsensicality.
        reference_ratings (pd.DataFrame): A DataFrame with columns ["userSessionId", "statementId", "I_agree"] containing the reference ratings. These ratings are used to determine the majority vote for each statement, which is then compared against the target_ratings to compute consensus and awareness scores. It can be the same as target_ratings.
        min_ratings_per_statement (int, optional): Minimum number of ratings required for a statement to be included in the analysis. Defaults to 10.
        min_statements_per_user (int, optional): Minimum number of statements a user must have rated for their commonsensicality score to be computed. Defaults to 5.

    Returns:
        pd.DataFrame: A DataFrame indexed by userSessionId with columns ["consensus", "awareness", "commonsensicality"] containing the computed scores for each user in target_ratings. Note that only users who have rated at least min_statements_per_user statements and only statements that have been rated by at least min_ratings_per_statement users (in both target and reference ratings) are included in the analysis.
    """
    # Check that required columns are present
    for col in ["userSessionId", "statementId", "I_agree"]:
        if col not in target_ratings.columns:
            raise ValueError(f"target_ratings must contain column '{col}'")
        if col not in reference_ratings.columns:
            raise ValueError(f"reference_ratings must contain column '{col}'")
    for col in ["others_agree"]:
        if col not in target_ratings.columns:
            raise ValueError(f"target_ratings must contain column '{col}'")

    # Remove columns other than the required ones to avoid confusion
    target_ratings = target_ratings[
        ["userSessionId", "statementId", "I_agree", "others_agree"]
    ].copy()
    reference_ratings = reference_ratings[
        ["userSessionId", "statementId", "I_agree"]
    ].copy()

    # Only consider users who have rated at least some minimum number of statements (this is done only for the target ratings)
    user_counts = target_ratings["userSessionId"].value_counts()
    valid_users = user_counts[user_counts >= min_statements_per_user].index
    target_ratings = target_ratings[target_ratings["userSessionId"].isin(valid_users)]

    # Only consider statements that have been rated by at least some minimum number of users (this is done separately only for reference ratings, since these determine the majority vote; we want to ensure the majority vote is based on a sufficient number of ratings). Note that this filtering may indirectly filter out some users in target_ratings who rated statements that fail this threshold, but we'll re-apply the user filter at the end to be safe.
    statement_counts_ref = reference_ratings["statementId"].value_counts()
    valid_statements_ref = statement_counts_ref[
        statement_counts_ref >= min_ratings_per_statement
    ].index
    reference_ratings = reference_ratings[
        reference_ratings["statementId"].isin(valid_statements_ref)
    ]

    # Only retain statements that are present in both target and reference ratings
    common_statements = set(target_ratings["statementId"]).intersection(
        set(reference_ratings["statementId"])
    )
    target_ratings = target_ratings[
        target_ratings["statementId"].isin(common_statements)
    ]
    reference_ratings = reference_ratings[
        reference_ratings["statementId"].isin(common_statements)
    ]

    # Re-apply min_statements_per_user now that statement filters are final.
    # A user may have passed the earlier check but have too few qualifying
    # statements after the min_ratings_per_statement and intersection filters.
    user_counts_final = target_ratings["userSessionId"].value_counts()
    valid_users_final = user_counts_final[
        user_counts_final >= min_statements_per_user
    ].index
    target_ratings = target_ratings[
        target_ratings["userSessionId"].isin(valid_users_final)
    ]

    # Average and majority vote per statement in reference ratings
    avg_vote_per_q = reference_ratings.groupby("statementId")["I_agree"].mean()
    maj_vote_per_q = (avg_vote_per_q >= 0.5).astype(int)

    # Consensus score per user in target ratings
    # Defintition (for each user): for each statement that the user rated, check if their "I_agree" rating matches the majority vote. Then average this across all statements they rated.
    merged = target_ratings.merge(
        maj_vote_per_q.rename("maj_vote"), on="statementId", how="inner"
    )
    merged["I_agree_eq_I_agree_maj"] = (merged["I_agree"] == merged["maj_vote"]).astype(
        int
    )
    consensus = (
        merged.groupby("userSessionId")["I_agree_eq_I_agree_maj"]
        .mean()
        .reset_index()
        .rename(columns={"I_agree_eq_I_agree_maj": "consensus"})
    )

    # Awareness score per user in target ratings
    # Definition (for each user): for each statement that the user rated, check if their "others_agree" rating matches the majority vote. Then average this across all statements they rated.
    merged["others_agree_eq_I_agree_maj"] = (
        merged["others_agree"] == merged["maj_vote"]
    ).astype(int)
    awareness = (
        merged.groupby("userSessionId")["others_agree_eq_I_agree_maj"]
        .mean()
        .reset_index()
        .rename(columns={"others_agree_eq_I_agree_maj": "awareness"})
    )
    # Merge consensus and awareness scores
    out = consensus.merge(awareness, on="userSessionId", how="inner")
    out["commonsensicality"] = np.sqrt(out["consensus"] * out["awareness"])

    out = out.set_index("userSessionId")[
        ["consensus", "awareness", "commonsensicality"]
    ]
    return out


def statement_commonsensicality(
    ratings: pd.DataFrame,
    min_ratings_per_statement: int = 10,
) -> pd.DataFrame:
    """Compute commonsensicality score for each statement based on the ratings in the given DataFrame.

    Args:
        ratings (pd.DataFrame): A DataFrame with columns ["statementId", "I_agree", "others_agree"] containing the ratings based on which to compute statement commonsensicality.
        min_ratings_per_statement (int, optional): The minimum number of ratings a statement must have to be included in the computation. Defaults to 10.

    Returns:
        pd.DataFrame: A DataFrame indexed by statementId with columns ["n_ratings", "I_agree_mean", "others_agree_mean", "consensus", "awareness", "commonsensicality"]. Note that only statements that have been rated by at least min_ratings_per_statement users are included in the analysis.
    """
    # Check that required columns are present
    for col in ["statementId", "I_agree", "others_agree"]:
        if col not in ratings.columns:
            raise ValueError(f"ratings must contain column '{col}'")

    # Remove columns other than the required ones to avoid confusion
    ratings = ratings[["statementId", "I_agree", "others_agree"]].copy()

    # Only consider statements that have been rated by at least some minimum number of ratings
    statement_counts = ratings["statementId"].value_counts()
    valid_statements = statement_counts[
        statement_counts >= min_ratings_per_statement
    ].index
    ratings = ratings[ratings["statementId"].isin(valid_statements)]

    # Group by each statement: count the number of ratings, average I_agree, and average others_agree
    out = ratings.groupby("statementId").agg(
        n_ratings=("I_agree", "count"),
        I_agree_mean=("I_agree", "mean"),
        others_agree_mean=("others_agree", "mean"),
    )

    # Consensus is how much the average I_agree deviates from 0.5 (max consensus at 0 or 1, min consensus at 0.5)
    out["consensus"] = 2 * np.abs(out["I_agree_mean"] - 0.5)

    # Awareness is how accurate the average others_agree predicts the majority I_agree
    out["maj_vote"] = (out["I_agree_mean"] >= 0.5).astype(int)
    out["awareness"] = np.where(
        out["maj_vote"] == 1, out["others_agree_mean"], 1 - out["others_agree_mean"]
    )

    # Commonsensicality is the geometric mean of consensus and awareness
    out["commonsensicality"] = np.sqrt(out["consensus"] * out["awareness"])

    # Drop intermediate "maj_vote" column
    out = out[
        [
            "n_ratings",
            "I_agree_mean",
            "others_agree_mean",
            "consensus",
            "awareness",
            "commonsensicality",
        ]
    ]

    return out
