"""Report how many statements exist per design point, using the live top-level tables.

Unlike the deployed Design Points dashboard (.scripts/visualize), which reads a
one-time, never-regenerated snapshot (.scripts/visualize/data/statement_properties.csv),
this script reads directly from the repo-root statements/ and statementproperties/
tables, so it reflects the current state of the real dataset.

statementproperties/ stores six long-format rows per statement (name, available),
using the opposite-polarity vocabulary from the live platform's schema. Verified
against statements 1-3 by cross-checking against the visualize snapshot:

    top-level name (available=1)   <=>   wide column
    opinion                        <=>   fact = 0
    behavior                       <=>   physical = 0
    figure_of_speech               <=>   literal language = 0
    judgment                       <=>   positive = 0
    reasoning                      <=>   knowledge = 0
    everyday                       <=>   everyday = 1   (same polarity, no inversion)

Usage: python .scripts/statement-generation/gap_analysis.py [--min-ratings 10]
"""
import argparse
import itertools
import os
from pathlib import Path

import pandas as pd

# Default to the in-repo location for local dev/CLI use; override with
# REPO_ROOT (e.g. in the visualize Docker image, which vendors statements/ and
# statementproperties/ flat rather than preserving the repo's directory nesting).
REPO_ROOT = Path(os.environ.get("REPO_ROOT", Path(__file__).resolve().parents[2]))

# (top-level name, wide column, invert)
NAME_MAP = [
    ("opinion", "fact", True),
    ("behavior", "physical", True),
    ("figure_of_speech", "literal language", True),
    ("judgment", "positive", True),
    ("reasoning", "knowledge", True),
    ("everyday", "everyday", False),
]
PROP_COLS = [wide for _, wide, _ in NAME_MAP]


def load_chunks(folder: str) -> pd.DataFrame:
    files = sorted((REPO_ROOT / folder).glob(f"{folder}_*.csv"))
    return pd.concat([pd.read_csv(f) for f in files], ignore_index=True)


def load_wide_properties() -> pd.DataFrame:
    long_df = load_chunks("statementproperties")
    pivot = long_df.pivot(index="statementId", columns="name", values="available")
    wide = pd.DataFrame(index=pivot.index)
    for name, col, invert in NAME_MAP:
        wide[col] = (1 - pivot[name]) if invert else pivot[name]
    return wide.reset_index()


def load_rating_counts() -> pd.Series:
    answers = load_chunks("answers")
    return answers.groupby("statementId").size()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min-ratings", type=int, default=10,
                         help="Ratings a statement needs to count toward a design point (default: 10, matching the dashboard).")
    args = parser.parse_args()

    statements = pd.read_csv(REPO_ROOT / "statements" / "statements_1.csv",
                              usecols=["id", "statement", "published"])
    props = load_wide_properties()
    merged = statements.merge(props, left_on="id", right_on="statementId", how="left")
    merged = merged.dropna(subset=PROP_COLS)
    for col in PROP_COLS:
        merged[col] = merged[col].astype(int)

    rating_counts = load_rating_counts()
    merged["n_ratings"] = merged["id"].map(rating_counts).fillna(0).astype(int)
    eligible = merged[merged["n_ratings"] >= args.min_ratings]

    rows = []
    for combo in itertools.product([0, 1], repeat=len(PROP_COLS)):
        mask_all = pd.Series(True, index=merged.index)
        mask_eligible = pd.Series(True, index=eligible.index)
        for col, val in zip(PROP_COLS, combo):
            mask_all &= merged[col] == val
            mask_eligible &= eligible[col] == val
        rows.append({
            **dict(zip(PROP_COLS, combo)),
            "n_statements": int(mask_all.sum()),
            "n_eligible": int(mask_eligible.sum()),
        })

    report = pd.DataFrame(rows).sort_values("n_eligible", ascending=False)
    dashboard_shown = (report["n_eligible"] >= 5).sum()
    print(f"Total statements tagged with all six properties: {len(merged)}")
    print(f"Statements with >= {args.min_ratings} ratings: {len(eligible)}")
    print(f"Design points with n_eligible >= 5 (would appear on dashboard): {dashboard_shown} / 64")
    print(f"Design points with n_eligible >= 10 (your preferred bar): {(report['n_eligible'] >= 10).sum()} / 64")
    print(f"Design points with zero tagged statements at all: {(report['n_statements'] == 0).sum()} / 64")
    print()
    pd.set_option("display.width", 140)
    print(report.to_string(index=False))
    report.to_csv(Path(__file__).with_name("gap_analysis.csv"), index=False)
    print(f"\nFull table written to {Path(__file__).with_name('gap_analysis.csv')}")


if __name__ == "__main__":
    main()
