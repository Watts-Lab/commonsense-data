import argparse
import ast
import csv
from copy import deepcopy
import json
import os
import traceback
import tempfile
from pathlib import Path
from string import Template
from concurrent.futures import ThreadPoolExecutor, as_completed
import json_repair
import jsonschema
import requests
import yaml
from dotenv import load_dotenv
import pandas as pd
from tqdm import tqdm
import random
from openai import OpenAI

# Load prompt wording relative to this script, not the working directory.
with Path(__file__).with_name("prompt.yml").open(encoding="utf-8") as handle:
    PROMPT_CONFIG = yaml.safe_load(handle)
FEATURE_DEFINITIONS = PROMPT_CONFIG["feature_definitions"]


def create_prompt(features, num_statements=20):
    feature_names = list(FEATURE_DEFINITIONS.keys())
    random.shuffle(feature_names)
    feature_descriptions = []
    example_features = {}
    for i, feature in enumerate(feature_names):
        subfeatures = FEATURE_DEFINITIONS[feature]
        selected = [name for name in subfeatures if name in features]
        if len(selected) != 1:
            raise ValueError(f"Expected exactly one choice for '{feature}'.")
        found = selected[0]
        opposite = next(name for name in subfeatures if name != found)
        details = subfeatures[found]
        examples = "\n".join(
            Template(PROMPT_CONFIG["example_template"]).substitute(example=example)
            for example in details["examples"]
        )
        feature_descriptions.append(
            Template(PROMPT_CONFIG["feature_template"]).substitute(
                number=i + 1,
                name=found.capitalize(),
                definition=details["definition"],
                examples=examples,
                opposite=opposite.capitalize(),
                opposite_definition=subfeatures[opposite]["definition"],
            )
        )
        example_features[found] = {
            "explanation": Template(PROMPT_CONFIG["explanation_template"]).substitute(
                feature=found
            ),
            "confidence": 10,
        }
    example_json = json.dumps(
        {
            "statements": [
                {
                    "statement": PROMPT_CONFIG["statement_example"],
                    "features": example_features,
                }
            ]
        },
        indent=4,
    )
    prompt = Template(PROMPT_CONFIG["template"]).substitute(
        num_statements=num_statements,
        features="\n" + "\n".join(feature_descriptions),
        example_json=example_json,
    )

    response_format = deepcopy(PROMPT_CONFIG["response_format"])

    schema_features = response_format["json_schema"]["schema"]["properties"][
        "statements"
    ]["items"]["properties"]["features"]
    for feature in feature_names:
        subfeatures = FEATURE_DEFINITIONS[feature]
        for subfeature in subfeatures.keys():
            if subfeature in features:
                schema_features["properties"][subfeature] = deepcopy(
                    PROMPT_CONFIG["feature_schema"]
                )
                schema_features["required"].append(subfeature)

    return prompt, response_format


value_1_features = []
for dichotomy_name, definition in FEATURE_DEFINITIONS.items():
    value_1, value_0 = dichotomy_name.split("/")
    value_1_features.append(value_1)
column_order = []
for feature in value_1_features:
    column_order.append(f"{feature}")
    column_order.append(f"{feature}_explanation")
    column_order.append(f"{feature}_confidence")


def parse_llm_json(raw_response):
    # Remove leading/trailing whitespace
    cleaned = raw_response.strip()

    # Strip the leading markdown tags
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]

    # Strip the trailing markdown tags
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]

    # Parse the cleaned string, repairing common LLM JSON issues (trailing commas, etc.)
    result = json_repair.loads(cleaned.strip())
    assert isinstance(result, dict)
    return result


def parse_results(response_json: dict, design_point: list):
    # Build a lookup: feature name -> (value_1 column name, 0-or-1 value)
    feature_to_col_and_value = {}
    for dichotomy_name, definition in FEATURE_DEFINITIONS.items():
        value_1, _ = dichotomy_name.split("/")
        for feature_name, details in definition.items():
            feature_to_col_and_value[feature_name] = (value_1, details["value"])

    output = pd.DataFrame(columns=column_order)
    for item in response_json["statements"]:
        statement = item["statement"]
        output.loc[statement, "commonsense"] = item.get("commonsense", "")
        features = item["features"]
        for feature_name in design_point:
            col, value = feature_to_col_and_value[feature_name]
            feature_details = features[feature_name]
            output.loc[statement, col] = value
            output.loc[statement, f"{col}_explanation"] = feature_details["explanation"]
            output.loc[statement, f"{col}_confidence"] = feature_details["confidence"]
    output.index.name = "statement"
    output.reset_index(inplace=True)
    return output


def prepare_output_columns(output_path):
    """Preserve existing CSV column order, adding commonsense for older files."""
    if not output_path.exists() or output_path.stat().st_size == 0:
        return ["statement", *column_order, "commonsense", "design_point", "model"]
    with output_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        columns = list(reader.fieldnames or [])
        if "commonsense" in columns:
            return columns
        columns.append("commonsense")
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", newline="", encoding="utf-8", dir=output_path.parent,
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                writer = csv.DictWriter(temporary, fieldnames=columns)
                writer.writeheader()
                writer.writerows(reader)
            temporary_path.replace(output_path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    return columns


def generate_design_points():
    # A design point is a combination of each of the six dichotomies
    # Since we have 6 dichotomies, there are 2^6 = 64 design points
    dichotomy_names = list(FEATURE_DEFINITIONS.keys())
    design_points = []
    for i in range(2 ** len(dichotomy_names)):
        design_point = []
        for j in range(len(dichotomy_names)):
            dichotomy_name = dichotomy_names[j]
            value_1, value_0 = dichotomy_name.split("/")
            if (i >> j) & 1:
                design_point.append(value_1)
            else:
                design_point.append(value_0)
        design_points.append(design_point)
    return design_points


def load_generated_design_points(output_path, model_name):
    """A design point is generated once it has a saved statement for this model."""
    if not output_path.exists() or output_path.stat().st_size == 0:
        return set()

    generated = set()
    valid_points = {frozenset(dp) for dp in generate_design_points()}
    with output_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if not {"statement", "design_point", "model"}.issubset(reader.fieldnames or []):
            raise ValueError(
                f"Missing statement, design_point, or model column in {output_path}"
            )
        for row in reader:
            if row["model"] != model_name or not (row["statement"] or "").strip():
                continue
            try:
                point = ast.literal_eval(row["design_point"])
                if not isinstance(point, list) or len(point) != 6:
                    raise ValueError("Expected six features")
                key = frozenset(point)
                if key not in valid_points:
                    raise ValueError("Unknown design point")
            except (ValueError, SyntaxError, TypeError) as exc:
                raise ValueError(
                    f"Invalid design point in {output_path} near line {reader.line_num}"
                ) from exc
            generated.add(key)
    return generated


def get_reasoning_config(model_name):
    """Select medium only when OpenRouter's model metadata allows it."""
    print(f"Checking reasoning options for {model_name}…")
    response = requests.get("https://openrouter.ai/api/v1/models", timeout=30)
    response.raise_for_status()
    model = next(
        (item for item in response.json()["data"] if item["id"] == model_name),
        None,
    )
    if model is None:
        raise ValueError(f"Model {model_name!r} was not found in OpenRouter's catalog.")
    reasoning = model.get("reasoning") or {}
    if "supported_efforts" not in reasoning:
        print("Reasoning effort selection is not advertised; using model defaults.")
        return {}
    efforts = reasoning["supported_efforts"]
    # OpenRouter documents null as accepting all gateway effort values.
    if efforts is None or "medium" in efforts:
        print('Reasoning: using reasoning.effort = "medium".')
        return {"reasoning": {"effort": "medium"}}
    print(f"Supported reasoning efforts: {efforts}; medium unavailable, using model defaults.")
    return {}


def process_design_point(
    design_point, model_name, num_statements, max_retries=3, reasoning_config=None
):
    prompt, response_format = create_prompt(design_point, num_statements=num_statements)
    schema = response_format["json_schema"]["schema"]
    total_cost = 0.0

    for attempt in range(max_retries):
        response = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": prompt}],
            temperature=1,
            seed=attempt,  # vary seed so retries produce different outputs
            max_tokens=16384,
            response_format=response_format,  # type: ignore[arg-type]
            extra_body=reasoning_config or {},
        )
        cost_details = getattr(response.usage, "cost_details", {}) or {}
        total_cost += sum(cost_details.values())

        response_json = parse_llm_json(response.choices[0].message.content or "")
        try:
            jsonschema.validate(response_json, schema)
        except jsonschema.ValidationError as e:
            if attempt == max_retries - 1:
                raise
            tqdm.write(
                f"  Validation error on attempt {attempt + 1} for {design_point}: {e.message}. Retrying..."
            )
            continue

        df = parse_results(response_json, design_point)
        df["design_point"] = str(design_point)
        df["model"] = model_name
        return df, total_cost

    raise RuntimeError(
        f"Failed to get valid response for {design_point} after {max_retries} attempts"
    )


if __name__ == "__main__":
    import threading

    parser = argparse.ArgumentParser(description="Generate common-sense statements.")
    parser.add_argument(
        "--random-prompt-view",
        action="store_true",
        help="Print a random design point's prompt and JSON schema, then exit without calling the API.",
    )
    parser.add_argument(
        "--model-name",
        default="anthropic/claude-fable-5.1",
        help="OpenRouter model name (default: %(default)s).",
    )
    args = parser.parse_args()

    design_points = generate_design_points()
    model_name = args.model_name
    num_statements = 20
    if args.random_prompt_view:
        design_point = random.choice(design_points)
        prompt, response_format = create_prompt(
            design_point, num_statements=num_statements
        )
        print(f"Model: {model_name}")
        print(f"Design point: {design_point}\n")
        print(prompt)
        print("\nJSON schema (response_format):")
        print(json.dumps(response_format, indent=2))
        raise SystemExit(0)

    # Keep each provider/model's results separate, regardless of the working directory.
    model_folder = model_name.replace("/", "--")
    output_path = (
        Path(__file__).resolve().parent / "data" / model_folder / "statements.csv"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    generated = load_generated_design_points(output_path, model_name)
    pending_points = [dp for dp in design_points if frozenset(dp) not in generated]
    print(
        f"Model: {model_name} — {len(generated)}/{len(design_points)} design points "
        f"already generated; skipping them. {len(pending_points)} remaining to generate."
    )
    if not pending_points:
        print("All design points are already generated. No model queries needed.")
        raise SystemExit(0)

    try:
        reasoning_config = get_reasoning_config(model_name)
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        print(f"Could not check model reasoning options: {type(exc).__name__}: {exc}")
        raise SystemExit(1)
    output_columns = prepare_output_columns(output_path)
    load_dotenv()
    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=os.getenv("OPENROUTER_API_KEY"),
    )

    csv_lock = threading.Lock()
    wrote_header = output_path.exists() and output_path.stat().st_size > 0
    total_cost = 0.0
    print(f"Saving statements to {output_path}")
    failures = []
    saved_count = 0

    with ThreadPoolExecutor() as executor:
        futures = {
            executor.submit(
                process_design_point, dp, model_name, num_statements,
                reasoning_config=reasoning_config,
            ): dp
            for dp in pending_points
        }
        with tqdm(total=len(futures)) as pbar:
            for future in as_completed(futures):
                design_point = futures[future]
                stage = "generating/parsing/validating the response"
                try:
                    df, cost = future.result()
                    total_cost += cost
                    stage = "creating the final data"
                    if df.empty:
                        raise ValueError(
                            "Model returned no statements; no data was saved."
                        )
                    stage = f"saving CSV to {output_path}"
                    with csv_lock:
                        df.reindex(columns=output_columns).to_csv(
                            output_path, mode="a", header=not wrote_header, index=False
                        )
                        wrote_header = True
                    saved_count += 1
                    tqdm.write(
                        f"  Done: {design_point}  cost=${cost:.6f}  total=${total_cost:.6f}"
                    )
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    failures.append((design_point, stage, error))
                    tqdm.write(
                        f"  FAILED [{model_name}] {design_point}\n"
                        f"  While {stage}: {error}\n{traceback.format_exc()}"
                    )
                finally:
                    pbar.update(1)

    print(f"Finished: {saved_count} design points saved; {len(failures)} failed.")
    if failures:
        print("Failed design points:")
        for design_point, stage, error in failures:
            print(f"  {design_point}\n    While {stage}: {error}")
        raise SystemExit(1)
