"""
# Utility functions to load data from CSV files in specified directories.
"""

import os
from typing import Optional

import pandas as pd


def load_dataframes(
    base_path: str, date: Optional[str] = None, num_samples: Optional[int] = None
) -> pd.DataFrame:
    """
    Load and concatenate CSV files from a directory.
    Only loads files named after the folder with _<number>.csv suffix.
    Optionally filter rows by date in the 'createdAt' column and/or limit number of samples.

    Args:
        base_path (str): Directory containing CSV files.
        date (Optional[str]): Only include rows where 'createdAt' contains this date string.
        num_samples (Optional[int]): Limit to first N rows after filtering.

    Returns:
        pd.DataFrame: Concatenated DataFrame.
    """
    folder_name = os.path.basename(os.path.normpath(base_path))
    files = sorted(os.listdir(base_path))
    files = [f for f in files if f.startswith(folder_name + "_") and f.endswith(".csv")]
    files = [os.path.join(base_path, f) for f in files]
    print(f"Loading files from {base_path}:")
    for file in files:
        print("  -", file)
    df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    if date:
        df = df[df["createdAt"].astype(str).str.contains(date)]
    if num_samples is not None:
        df = df.head(num_samples)
    return df


def load_individuals(
    date: Optional[str] = None, num_samples: Optional[int] = None
) -> pd.DataFrame:
    """
    Loads individual data samples from the specified directory.

    Args:
        date (Optional[str]): A string representing the date to filter the data.
            If None, loads data from all dates.
        num_samples (Optional[int]): The number of samples to load.
            If None, loads all available samples.

    Returns:
        pd.DataFrame: A DataFrame containing the loaded individual data samples.
    """
    return load_dataframes("../individuals", date, num_samples)


def load_answers(
    date: Optional[str] = None, num_samples: Optional[int] = None
) -> pd.DataFrame:
    """
    Loads answer data samples from the specified directory.

    Args:
        date (Optional[str]): A string representing the date to filter the data.
            If None, loads data from all dates.
        num_samples (Optional[int]): The number of samples to load.
            If None, loads all available samples.
    Returns:
        pd.DataFrame: A DataFrame containing the loaded answer data samples.
    """
    return load_dataframes("../answers", date, num_samples)


def load_statements(
    date: Optional[str] = None, num_samples: Optional[int] = None
) -> pd.DataFrame:
    """
    Loads statement data samples from the specified directory.

    Args:
        date (Optional[str]): A string representing the date to filter the data.
            If None, loads data from all dates.
        num_samples (Optional[int]): The number of samples to load.
            If None, loads all available samples.

    Returns:
        pd.DataFrame: A DataFrame containing the loaded statement data samples.
    """
    return load_dataframes("../statements", date, num_samples)


def load_statements_properties(
    date: Optional[str] = None, num_samples: Optional[int] = None
) -> pd.DataFrame:
    """
    Loads statement properties data samples from the specified directory.

    Args:
        date (Optional[str]): A string representing the date to filter the data.
            If None, loads data from all dates.
        num_samples (Optional[int]): The number of samples to load.
            If None, loads all available samples.

    Returns:
        pd.DataFrame: A DataFrame containing the loaded statement properties data samples.
    """
    return load_dataframes("../statementproperties", date, num_samples)


def load_experiments(
    date: Optional[str] = None, num_samples: Optional[int] = None
) -> pd.DataFrame:
    """
    Loads experiment data samples from the specified directory.

    Args:
        date (Optional[str]): A string representing the date to filter the data.
            If None, loads data from all dates.
        num_samples (Optional[int]): The number of samples to load.
            If None, loads all available samples.

    Returns:
        pd.DataFrame: A DataFrame containing the loaded experiment data samples.
    """
    return load_dataframes("../experiments", date, num_samples)
