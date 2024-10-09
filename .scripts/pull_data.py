"""
This script pulls data from the database, saves it to CSV files in chunks,
and commits the changes to the local repo.
"""

import sys
import os
import json
import csv
import math
import mysql.connector
import numpy as np
import pandas as pd
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Database connection parameters
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_HOST = os.getenv("DB_HOST")
DB_NAME = os.getenv("DB_NAME")

# List of tables to process
TABLES = ["statements", "answers", "statementproperties", "experiments", "individuals"]

# Maximum file size in bytes (50 MB)
MAX_FILE_SIZE = 90 * 1024 * 1024  # 50 MB in bytes

# Metadata file to track last processed IDs
METADATA_FILE = "./.scripts/metadata.json"


class NpEncoder(json.JSONEncoder):
    """Custom JSON encoder for NumPy types."""

    def default(self, o):
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.int64):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        return super(NpEncoder, self).default(o)


def load_metadata():
    """Load metadata from file or initialize if file doesn't exist."""
    if os.path.exists(METADATA_FILE):
        try:
            with open(METADATA_FILE, encoding="utf-8", mode="r") as f:
                metadata = json.load(f)
        except json.JSONDecodeError:
            metadata = {table: 0 for table in TABLES}
    else:
        # Initialize metadata with zero for each table
        metadata = {table: 0 for table in TABLES}
    return metadata


def save_metadata(metadata):
    """Save metadata to file."""
    with open(METADATA_FILE, encoding="utf-8", mode="w") as f:
        json.dump(metadata, f, cls=NpEncoder, indent=2)


def get_new_records(connection, table, last_id):
    """Fetch new records from the database for a specific table."""
    query = f"SELECT * FROM {table} WHERE id > %s"
    df = pd.read_sql(query, connection, params=(last_id,))

    # Remove emails from urlParams column in experiments and individuals tables
    pattern = r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
    if table in ["experiments", "individuals"]:
        df["urlParams"] = df["urlParams"].str.replace(pattern, "#", regex=True)

    return df


def split_dataframe(df, chunk_size):
    """Split a DataFrame into smaller DataFrames of a specified size."""
    num_chunks = math.ceil(len(df) / chunk_size)
    return (df[i * chunk_size : (i + 1) * chunk_size] for i in range(num_chunks))


def get_existing_file_index(folder_path):
    """Get the next file index based on existing files in the folder."""
    existing_files = [f for f in os.listdir(folder_path) if f.endswith(".csv")]
    if not existing_files:
        return 1
    else:
        indices = [int(f.split("_")[-1].split(".")[0]) for f in existing_files]
        return max(indices) + 1


def get_last_id_from_files(table):
    """Get the last 'id' from the CSV files in the table's folder."""
    folder_path = table
    if not os.path.exists(folder_path):
        return None

    existing_files = [f for f in os.listdir(folder_path) if f.endswith(".csv")]
    if not existing_files:
        return None

    existing_files = sorted(
        existing_files, key=lambda x: int(x.split("_")[1].split(".")[0])
    )

    last_file = existing_files[-1]
    file_path = os.path.join(folder_path, last_file)
    print(f"Reading last id from file: {file_path}")
    try:
        # Read only the 'id' column
        df = pd.read_csv(file_path, usecols=["id"])
        if df.empty:
            return None
        max_id = df["id"].max()
        return max_id
    except Exception as e:
        print(f"Error reading file {file_path}: {e}")
        return None


def verify_metadata_with_files(metadata):
    """Verify that the last id in the CSV files matches the metadata for each table."""
    for table in TABLES:
        metadata_last_id = metadata.get(table, 0)
        file_last_id = get_last_id_from_files(table)
        if file_last_id is None:
            # No data in files, so last_id should be zero or absent
            if metadata_last_id != 0:
                print(
                    f"Error: Metadata last_id ({metadata_last_id}) does not match last id in files (None) for table '{table}'."
                )
                sys.exit(1)
        else:
            if metadata_last_id != file_last_id:
                print(
                    f"Error: Metadata last_id ({metadata_last_id}) does not match last id in files ({file_last_id}) for table '{table}'."
                )
                sys.exit(1)
    print(
        "Metadata verification successful. Last ids in metadata match the CSV files for all tables."
    )


def save_dataframe_chunks(df, folder_path, base_filename):
    """
    Save DataFrame to CSV files, appending to existing files if under MAX_FILE_SIZE.
    """
    existing_files = [f for f in os.listdir(folder_path) if f.endswith(".csv")]

    if not existing_files:
        file_index = 1
    else:
        existing_files.sort(key=lambda x: int(x.split("_")[-1].split(".")[0]))
        last_file = existing_files[-1]
        file_index = int(last_file.split("_")[-1].split(".")[0])

    while not df.empty:
        file_path = os.path.join(folder_path, f"{base_filename}_{file_index}.csv")

        if os.path.exists(file_path):
            current_file_size = os.path.getsize(file_path)
            if current_file_size < MAX_FILE_SIZE:
                file_mode = "a"
                write_header = False
            else:
                file_index += 1
                file_path = os.path.join(
                    folder_path, f"{base_filename}_{file_index}.csv"
                )
                file_mode = "w"
                write_header = True
        else:
            file_mode = "w"
            write_header = True

        with open(file_path, mode=file_mode, newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=df.columns)
            if write_header:
                writer.writeheader()

            total_rows_written = 0

            for idx, row in df.iterrows():
                row_dict = row.to_dict()
                row_data = {
                    key: "" if pd.isna(value) else str(value)
                    for key, value in row_dict.items()
                }
                row_string = ",".join(row_data.values()) + "\n"
                row_size = len(row_string.encode("utf-8"))

                current_file_size = os.path.getsize(file_path)
                if current_file_size + row_size > MAX_FILE_SIZE:
                    # Stop writing to this file and start a new one
                    break

                writer.writerow(row_data)
                total_rows_written += 1

            csvfile.flush()

        # Remove the rows that have been written
        df = df.iloc[total_rows_written:]
        file_index += 1

    print(f"Saved records to files in {folder_path}")


def main():
    """
    Main function to pull data from the database, save it to CSV files in chunks,
    """
    metadata = load_metadata()

    # Verify that last ids in metadata match the last ids in CSV files
    verify_metadata_with_files(metadata)

    try:
        connection = mysql.connector.connect(
            user=DB_USER,
            password=DB_PASSWORD,
            host=DB_HOST,
            database=DB_NAME,
        )

        for table in TABLES:
            last_id = metadata.get(table, 0)
            print(f"Processing table '{table}' from last_id {last_id}")

            # Fetch new records
            df = get_new_records(connection, table, last_id)

            if df.empty:
                print(f"No new records found for table '{table}'")
                continue

            max_id = df["id"].max()
            metadata[table] = max_id

            folder_path = table
            os.makedirs(folder_path, exist_ok=True)

            # Save DataFrame to CSV in chunks
            save_dataframe_chunks(df, folder_path, table)

        print("All tables processed successfully")
        # Save updated metadata
        save_metadata(metadata)

        # Close the database connection
        connection.close()

    except mysql.connector.Error as e:
        print(f"Error connecting to MariaDB Platform: {e}")
        sys.exit(1)

    finally:
        if "connection" in locals() and connection.is_connected():
            connection.close()


if __name__ == "__main__":
    main()
