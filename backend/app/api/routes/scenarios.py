from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.services.scenario_loader import ScenarioDefinition, list_scenario_ids, load_scenario

router = APIRouter()


@router.get("/scenarios")
def list_scenarios() -> dict[str, list[str]]:
    return {"scenarios": list_scenario_ids()}


@router.get("/scenarios/{scenario_id}", response_model=ScenarioDefinition)
def get_scenario(scenario_id: str) -> ScenarioDefinition:
    try:
        return load_scenario(scenario_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
