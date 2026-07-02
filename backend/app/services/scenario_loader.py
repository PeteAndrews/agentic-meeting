from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from app.storage.jsonl import data_dir


class CalibrationQuestion(BaseModel):
    id: str = Field(min_length=1, max_length=32)
    text: str = Field(min_length=1, max_length=500)
    matchKeywords: list[str] = Field(default_factory=list)


class ScenarioDefinition(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    displayName: str = Field(min_length=1, max_length=128)
    description: str = Field(min_length=1, max_length=1000)
    discussionKeyPoints: list[str] = Field(min_length=1)
    calibrationQuestions: list[CalibrationQuestion] = Field(min_length=1)
    voiceSamplePassage: Optional[str] = None


def _scenarios_dir() -> Path:
    return data_dir() / "scenarios"


@lru_cache(maxsize=32)
def load_scenario(scenario_id: str) -> ScenarioDefinition:
    path = _scenarios_dir() / f"{scenario_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Unknown scenario: {scenario_id}")
    data = json.loads(path.read_text(encoding="utf-8"))
    scenario = ScenarioDefinition.model_validate(data)
    if scenario.id != scenario_id:
        raise ValueError(f"Scenario file id mismatch: expected {scenario_id!r}, got {scenario.id!r}")
    return scenario


def list_scenario_ids() -> list[str]:
    directory = _scenarios_dir()
    if not directory.exists():
        return []
    return sorted(p.stem for p in directory.glob("*.json"))


def questions_for_calibration(
    scenario: ScenarioDefinition,
    *,
    drop_index: int | None,
) -> list[CalibrationQuestion]:
    questions = scenario.calibrationQuestions
    if drop_index is None:
        return list(questions)
    return [q for i, q in enumerate(questions) if i != drop_index]
