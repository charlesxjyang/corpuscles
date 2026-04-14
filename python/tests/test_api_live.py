"""Live API tests — hits the deployed Railway endpoint with real data.
Run with: pytest tests/test_api_live.py -v
"""

import os
import sys
import json
import pytest
import requests
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from echem_parse import load

API_URL = os.environ.get("API_URL", "https://api-production-3527.up.railway.app")
TEST_DATA = os.path.join(os.path.dirname(__file__), "..", "..", "test_data")


def _path(subdir, filename):
    return os.path.join(TEST_DATA, subdir, filename)


def _load_eis(filepath):
    """Load an EIS file and return freq, zr, zi arrays."""
    r = load(filepath)
    return (
        r.data["frequency_hz"].tolist(),
        r.data["z_real_ohm"].tolist(),
        r.data["z_imag_ohm"].tolist(),
    )


# ---- Health ----

def test_health():
    resp = requests.get(f"{API_URL}/api/v1/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---- Kramers-Kronig on all EIS files ----

@pytest.mark.parametrize("filepath,name", [
    (_path("eis", "exampleData.csv"), "EIS CSV"),
    (_path("gamry", "exampleDataGamry.DTA"), "Gamry DTA"),
    (_path("biologic", "v1150_PEIS.mpr"), "Biologic PEIS"),
    (_path("biologic", "v1150_GEIS.mpr"), "Biologic GEIS"),
])
def test_kramers_kronig(filepath, name):
    freq, zr, zi = _load_eis(filepath)
    resp = requests.post(f"{API_URL}/api/v1/analyze", json={
        "type": "kramers_kronig",
        "params": {"frequency": freq, "z_real": zr, "z_imag": zi},
    })
    assert resp.status_code == 200, f"{name}: {resp.text}"
    data = resp.json()["data"]
    assert data["M"] > 0, f"{name}: M={data['M']}"
    assert 0 < data["mu"] < 2, f"{name}: mu={data['mu']}"
    print(f"  {name}: M={data['M']}, mu={data['mu']:.4f}, valid={data['valid']}")


# ---- Circuit fitting on all EIS files ----

@pytest.mark.parametrize("filepath,name", [
    (_path("eis", "exampleData.csv"), "EIS CSV"),
    (_path("gamry", "exampleDataGamry.DTA"), "Gamry DTA"),
    (_path("biologic", "v1150_PEIS.mpr"), "Biologic PEIS"),
])
def test_circuit_fit_auto(filepath, name):
    freq, zr, zi = _load_eis(filepath)
    resp = requests.post(f"{API_URL}/api/v1/analyze", json={
        "type": "circuit_fit",
        "params": {"frequency": freq, "z_real": zr, "z_imag": zi, "auto_fit": True},
    })
    assert resp.status_code == 200, f"{name}: {resp.text}"
    data = resp.json()["data"]
    assert data["residual_rmse"] < 0.5, f"{name}: RMSE={data['residual_rmse']:.4f}"
    assert len(data["param_values"]) > 0
    print(f"  {name}: circuit={data['circuit_string']}, RMSE={data['residual_rmse']:.1%}")


@pytest.mark.parametrize("filepath,name", [
    (_path("eis", "exampleData.csv"), "EIS CSV"),
    (_path("gamry", "exampleDataGamry.DTA"), "Gamry DTA"),
])
def test_circuit_fit_manual(filepath, name):
    freq, zr, zi = _load_eis(filepath)
    resp = requests.post(f"{API_URL}/api/v1/analyze", json={
        "type": "circuit_fit",
        "params": {
            "frequency": freq, "z_real": zr, "z_imag": zi,
            "circuit_string": "R0-p(R1,CPE1)",
        },
    })
    assert resp.status_code == 200, f"{name}: {resp.text}"
    data = resp.json()["data"]
    assert len(data["param_values"]) == 4  # R0, R1, Q, alpha
    print(f"  {name}: RMSE={data['residual_rmse']:.1%}")


# ---- DRT on all EIS files ----

@pytest.mark.parametrize("filepath,name", [
    (_path("eis", "exampleData.csv"), "EIS CSV"),
    (_path("gamry", "exampleDataGamry.DTA"), "Gamry DTA"),
    (_path("biologic", "v1150_PEIS.mpr"), "Biologic PEIS"),
])
def test_drt_simple(filepath, name):
    freq, zr, zi = _load_eis(filepath)
    resp = requests.post(f"{API_URL}/api/v1/analyze", json={
        "type": "drt_simple",
        "params": {"frequency": freq, "z_real": zr, "z_imag": zi},
    })
    assert resp.status_code == 200, f"{name}: {resp.text}"
    data = resp.json()["data"]
    assert len(data["tau"]) > 0, f"{name}: empty tau"
    assert max(data["gamma"]) > 0, f"{name}: gamma all zero"
    print(f"  {name}: {len(data['tau'])} tau points, gamma_max={max(data['gamma']):.4f}")


# ---- Permalink ----

def test_permalink_roundtrip():
    # Create
    resp = requests.post(f"{API_URL}/api/v1/share", json={
        "title": "Test Project",
        "description": "Automated test",
        "datasets": [{"filename": "test.csv", "data": {"f": [1, 2, 3]}}],
        "results": [],
    })
    assert resp.status_code == 200
    share_id = resp.json()["id"]
    assert len(share_id) == 8

    # Retrieve
    resp2 = requests.get(f"{API_URL}/api/v1/share/{share_id}")
    assert resp2.status_code == 200
    assert resp2.json()["title"] == "Test Project"
    assert resp2.json()["view_count"] >= 1


# ---- File parsing via API ----

@pytest.mark.parametrize("filepath,expected_type", [
    (_path("gamry", "exampleDataGamry.DTA"), "eis"),
    (_path("eis", "exampleData.csv"), "eis"),
    (_path("biologic", "v1150_PEIS.mpr"), "eis"),
    (_path("maccor", "BG_Maccor_Testdata - 079.txt"), "cycling"),
    (_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv"), "cycling"),
])
def test_parse_file(filepath, expected_type):
    name = os.path.basename(filepath)
    with open(filepath, "rb") as f:
        resp = requests.post(
            f"{API_URL}/api/v1/parse",
            files={"file": (name, f)},
        )
    assert resp.status_code == 200, f"{name}: {resp.text}"
    data = resp.json()
    assert data["rowCount"] > 0, f"{name}: empty data"
    assert data["experimentType"] == expected_type, f"{name}: expected {expected_type}, got {data['experimentType']}"
    print(f"  {name}: {data['rowCount']} rows, type={data['experimentType']}")
