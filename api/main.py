"""Corpuscles API — Electrochemical Impedance Analysis with permalink sharing."""

import os
import json
import tempfile
from datetime import datetime
from typing import Optional

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from nanoid import generate as nanoid

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, DeclarativeBase, Mapped, mapped_column
from sqlalchemy.dialects.postgresql import JSONB

# ---- App setup ----

app = FastAPI(title="Corpuscles API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/corpuscles"
)
# Railway provides DATABASE_URL with postgres:// prefix, asyncpg needs postgresql+asyncpg://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

engine = create_async_engine(DATABASE_URL)
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


# ---- Database models ----

class Base(DeclarativeBase):
    pass


class SharedProject(Base):
    __tablename__ = "shared_projects"

    id: Mapped[str] = mapped_column(sa.String(12), primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    title: Mapped[str] = mapped_column(sa.String(200), default="Untitled")
    description: Mapped[str] = mapped_column(sa.Text, default="")
    created_at: Mapped[datetime] = mapped_column(sa.DateTime, default=datetime.utcnow)
    view_count: Mapped[int] = mapped_column(sa.Integer, default=0)


# ---- Pydantic models ----

class ShareRequest(BaseModel):
    title: str = "Untitled"
    description: str = ""
    datasets: list[dict]
    results: list[dict]


class ShareResponse(BaseModel):
    id: str
    url: str


class AnalysisRequest(BaseModel):
    type: str
    params: dict


# ---- Startup ----

@app.on_event("startup")
async def startup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


# ---- Permalink endpoints ----

@app.post("/api/v1/share", response_model=ShareResponse)
async def create_share(req: ShareRequest):
    """Create a shareable permalink for a project."""
    share_id = nanoid(alphabet="abcdefghijklmnopqrstuvwxyz0123456789", size=8)

    project = SharedProject(
        id=share_id,
        title=req.title,
        description=req.description,
        data={
            "datasets": req.datasets,
            "results": req.results,
        },
    )

    async with async_session() as session:
        session.add(project)
        await session.commit()

    base_url = os.environ.get("BASE_URL", "http://localhost:5173")
    return ShareResponse(id=share_id, url=f"{base_url}/p/{share_id}")


@app.get("/api/v1/share/{share_id}")
async def get_share(share_id: str):
    """Retrieve a shared project by permalink ID."""
    async with async_session() as session:
        result = await session.execute(
            sa.select(SharedProject).where(SharedProject.id == share_id)
        )
        project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Shared project not found")

    # Increment view count
    async with async_session() as session:
        await session.execute(
            sa.update(SharedProject)
            .where(SharedProject.id == share_id)
            .values(view_count=SharedProject.view_count + 1)
        )
        await session.commit()

    return {
        "id": project.id,
        "title": project.title,
        "description": project.description,
        "data": project.data,
        "created_at": project.created_at.isoformat(),
        "view_count": project.view_count + 1,
    }


# ---- Server-side analysis endpoint ----

@app.post("/api/v1/analyze")
async def run_analysis(req: AnalysisRequest):
    """Run EIS analysis server-side using impedance.py and pyDRTtools."""
    import sys
    import types

    # Mock PyQt5 for pyDRTtools import
    for mod in ['PyQt5', 'PyQt5.QtGui', 'PyQt5.QtWidgets', 'PyQt5.QtCore']:
        if mod not in sys.modules:
            sys.modules[mod] = types.ModuleType(mod)

    try:
        params = req.params
        freq = np.array(params.get("frequency", []))
        zr = np.array(params.get("z_real", []))
        zi = np.array(params.get("z_imag", []))

        if req.type == "circuit_fit":
            from impedance.models.circuits import CustomCircuit
            Z = zr + 1j * zi
            circuit_str = params.get("circuit_string", "R0-p(R1,C1)-W1")
            guess = params.get("initial_guess")
            constants = params.get("constants", {})
            global_opt = params.get("global_opt", False)

            if guess is None:
                guess = [np.min(zr), np.max(zr) - np.min(zr), 1e-6, np.max(zr)]

            circuit = CustomCircuit(circuit_str, initial_guess=guess, constants=constants)
            circuit.fit(freq, Z, global_opt=global_opt)

            names, units = circuit.get_param_names()
            Z_fit = circuit.predict(freq)
            residual = float(np.sqrt(np.mean(np.abs(Z - Z_fit) ** 2)) / np.mean(np.abs(Z)))

            return {
                "type": "circuit_fit",
                "data": {
                    "param_names": names,
                    "param_units": units,
                    "param_values": circuit.parameters_.tolist(),
                    "param_conf": circuit.conf_.tolist() if circuit.conf_ is not None else None,
                    "z_fit_real": Z_fit.real.tolist(),
                    "z_fit_imag": Z_fit.imag.tolist(),
                    "residual_rmse": residual,
                    "circuit_string": circuit_str,
                },
            }

        elif req.type == "kramers_kronig":
            from impedance.validation import linKK
            Z = zr + 1j * zi
            c = params.get("c", 0.85)
            max_M = params.get("max_M", 50)
            M, mu, Z_fit, resids_real, resids_imag = linKK(freq, Z, c=c, max_M=max_M)
            return {
                "type": "kramers_kronig",
                "data": {
                    "M": int(M), "mu": float(mu), "valid": bool(mu < c),
                    "z_fit_real": Z_fit.real.tolist(), "z_fit_imag": Z_fit.imag.tolist(),
                    "resids_real": resids_real.tolist(), "resids_imag": resids_imag.tolist(),
                },
            }

        elif req.type.startswith("drt_"):
            from pyDRTtools.runs import EIS_object, simple_run, Bayesian_run, BHT_run
            eis = EIS_object(freq, zr, zi)

            method = req.type.replace("drt_", "")
            common = dict(
                rbf_type=params.get("rbf_type", "Gaussian"),
                der_used=params.get("der_used", "1st order"),
                shape_control="FWHM Coefficient",
                coeff=params.get("coeff", 0.5),
            )

            def to_float(val):
                v = np.asarray(val)
                return float(v.flat[0]) if v.size > 0 else 0.0

            if method == "simple":
                result = simple_run(
                    entry=eis, data_used=params.get("data_used", "Combined Re-Im Data"),
                    induct_used=1, cv_type=params.get("cv_type", "GCV"),
                    reg_param=params.get("reg_param", 1e-3), **common,
                )
                return {
                    "type": "drt_simple",
                    "data": {
                        "method": "simple",
                        "tau": result.out_tau_vec.tolist(),
                        "gamma": result.gamma.tolist(),
                        "R_inf": to_float(result.R),
                        "L": to_float(result.L),
                        "lambda_value": to_float(result.lambda_value),
                    },
                }

            elif method == "bayesian":
                result = Bayesian_run(
                    entry=eis, data_used=params.get("data_used", "Combined Re-Im Data"),
                    induct_used=1, cv_type=params.get("cv_type", "GCV"),
                    reg_param=params.get("reg_param", 1e-3),
                    NMC_sample=params.get("NMC_sample", 2000), **common,
                )
                return {
                    "type": "drt_bayesian",
                    "data": {
                        "method": "bayesian",
                        "tau": result.out_tau_vec.tolist(),
                        "gamma": result.gamma.tolist(),
                        "mean": result.mean.tolist(),
                        "lower_bound": result.lower_bound.tolist(),
                        "upper_bound": result.upper_bound.tolist(),
                        "R_inf": to_float(result.R),
                        "L": to_float(result.L),
                    },
                }

            elif method == "BHT" or method == "bht":
                result = BHT_run(entry=eis, **common)
                return {
                    "type": "drt_bht",
                    "data": {
                        "method": "BHT",
                        "tau_re": result.out_tau_vec.tolist() if hasattr(result, 'out_tau_vec') else [],
                        "gamma_re": result.mu_gamma_fine_re.tolist() if hasattr(result, 'mu_gamma_fine_re') else [],
                        "gamma_im": result.mu_gamma_fine_im.tolist() if hasattr(result, 'mu_gamma_fine_im') else [],
                        "scores": result.out_scores if hasattr(result, 'out_scores') else {},
                    },
                }

        elif req.type == "simulate_circuit":
            from impedance.models.circuits import CustomCircuit
            circuit_str = params.get("circuit_string", "R0-p(R1,C1)-W1")
            p = np.array(params["parameters"])
            circuit = CustomCircuit(circuit_str, initial_guess=p.tolist())
            circuit.parameters_ = p
            Z = circuit.predict(freq)
            return {
                "type": "simulate_circuit",
                "data": {
                    "frequency": freq.tolist(),
                    "z_real": Z.real.tolist(),
                    "z_imag": Z.imag.tolist(),
                },
            }

        else:
            raise HTTPException(status_code=400, detail=f"Unknown analysis type: {req.type}")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- File upload + parse endpoint ----

@app.post("/api/v1/parse")
async def parse_file(file: UploadFile = File(...)):
    """Parse an uploaded electrochemistry data file server-side."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
    from echem_parse import load

    with tempfile.NamedTemporaryFile(suffix=f"_{file.filename}", delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = load(tmp_path)
        df = result.data

        data_dict = {}
        for col in df.columns:
            vals = df[col].values
            if np.issubdtype(vals.dtype, np.floating):
                data_dict[col] = [float(v) if np.isfinite(v) else None for v in vals]
            elif np.issubdtype(vals.dtype, np.integer):
                data_dict[col] = [int(v) for v in vals]
            else:
                data_dict[col] = [str(v) for v in vals]

        return {
            "columns": df.columns.tolist(),
            "data": data_dict,
            "fileType": result.file_type.value,
            "experimentType": result.experiment_type.value,
            "metadata": {str(k): str(v) for k, v in result.metadata.items()},
            "rowCount": len(df),
        }
    finally:
        os.unlink(tmp_path)


# ---- Health check ----

@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}
