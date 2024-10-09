# Common Sense Data Repository

This repository contains data organized into various folders, each representing a table in the database.

## Folder Structure

- **statements**: Active statements running on the platform.
- **statementproperties**: Properties of the statements for the design point experiment.
- **answers**: Answers to the common sense questions uniquely identified by the `sessionId`.
- **experiments**: Experiments conducted on the platform. Each experiment is uniquely identified by the `experimentId`.
- **individuals**: Answers to the CRT and RMET questions uniquely identified by the `sessionId`.

## Usage

The data is stored in chunks of 100 megabytes each. To extract the data in python for example, you can use the following code:

```python
import pandas as pd

statements_csv = [f for f in os.listdir('statements') if f.endswith(".csv")]
statements = pd.concat([pd.read_csv(f'statements/{f}') for f in statements_csv])
```

It is possible to join the data from different tables using the `sessionId` or `experimentId` columns.

## License

To be determined.
