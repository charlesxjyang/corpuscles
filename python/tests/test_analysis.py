"""Tests for echem_parse analysis functions using impedance.py and pyDRTtools."""

import os
import sys
import pytest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from echem_parse import load
from echem_parse.analysis import (
    capacity_per_cycle,
    dqdv,
    capacity_fade_fit,
    nyquist_plot_data,
    bode_plot_data,
    equivalent_circuit_fit,
    kramers_kronig_validation,
    drt_analysis,
    drt_peak_analysis,
)

TEST_DATA = os.path.join(os.path.dirname(__file__), "..", "..", "test_data")


def _path(subdir, filename):
    return os.path.join(TEST_DATA, subdir, filename)


# ---- dQ/dV ----

class TestDQDV:
    def test_basic_monotonic(self):
        v = np.linspace(2.0, 4.0, 1000)
        q = v ** 2 / 10
        v_out, dq_out = dqdv(v, q)
        assert len(v_out) > 0
        assert np.all(np.isfinite(dq_out))

    def test_dqdv_peak_detection(self):
        v = np.linspace(3.0, 3.6, 2000)
        q = 1.0 / (1.0 + np.exp(-50 * (v - 3.3)))
        v_out, dq_out = dqdv(v, q, smoothing_window=51)
        peak_idx = np.argmax(np.abs(dq_out))
        assert abs(v_out[peak_idx] - 3.3) < 0.05

    def test_on_real_cycling_data(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        df = r.data
        cycle1 = df[df["cycle_number"] == 1]
        charge = cycle1[cycle1["current_a"] > 0]
        if len(charge) > 100:
            v_out, dq_out = dqdv(charge["voltage_v"].values, charge["capacity_ah"].values)
            assert len(v_out) > 0
            assert np.all(np.isfinite(dq_out))


# ---- Capacity per cycle ----

class TestCapacityPerCycle:
    def test_arbin_data(self):
        r = load(_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv"))
        cpc = capacity_per_cycle(r.data)
        assert len(cpc) > 0
        assert "charge_cap_ah" in cpc.columns
        assert "discharge_cap_ah" in cpc.columns
        assert "coulombic_efficiency" in cpc.columns

    def test_maccor_data(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        cpc = capacity_per_cycle(r.data)
        assert len(cpc) > 0
        assert cpc["charge_cap_ah"].max() > 0

    def test_coulombic_efficiency_range(self):
        r = load(_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv"))
        cpc = capacity_per_cycle(r.data)
        valid_ce = cpc.iloc[1:]["coulombic_efficiency"].dropna()
        if len(valid_ce) > 0:
            assert valid_ce.max() < 2.0


# ---- Capacity fade fitting ----

class TestCapacityFadeFit:
    def test_linear_fit(self):
        cycles = np.arange(1, 101)
        cap = 1.0 - 0.001 * cycles + np.random.normal(0, 0.001, 100)
        result = capacity_fade_fit(cycles, cap, model="linear")
        assert result["r_squared"] > 0.9
        assert abs(result["params"]["k"] - 0.001) < 0.01

    def test_sqrt_fit(self):
        cycles = np.arange(1, 101)
        cap = 1.0 - 0.01 * np.sqrt(cycles)
        result = capacity_fade_fit(cycles, cap, model="sqrt")
        assert result["r_squared"] > 0.99

    def test_power_fit(self):
        cycles = np.arange(1, 101)
        cap = 1.0 * cycles ** (-0.01)
        result = capacity_fade_fit(cycles, cap, model="power")
        assert result["r_squared"] > 0.99
        assert abs(result["params"]["alpha"] - 0.01) < 0.005


# ---- Plot data formatting ----

class TestPlotData:
    def test_nyquist_format(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        nd = nyquist_plot_data(
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            r.data["frequency_hz"].values,
        )
        assert "x" in nd and "y" in nd
        assert nd["y"].min() > 0  # -Z_imag should be positive (capacitive)

    def test_bode_format(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        bd = bode_plot_data(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
        )
        assert "frequency" in bd
        assert "magnitude" in bd
        assert "phase" in bd
        assert len(bd["frequency"]) == len(r.data)


# ---- EIS circuit fitting via impedance.py ----

class TestEISFitting:
    def test_randles_on_example_data(self):
        r = load(_path("eis", "exampleData.csv"))
        result = equivalent_circuit_fit(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            circuit_string="R0-p(R1,C1)-W1",
        )
        assert result["residual_rmse"] < 0.25
        assert len(result["param_names"]) == 4
        assert len(result["param_values"]) == 4
        assert result["param_conf"] is not None

    def test_synthetic_rc_recovery(self):
        R0, R1, C1 = 100.0, 50.0, 1e-6
        freq = np.logspace(-2, 5, 100)
        omega = 2 * np.pi * freq
        Z = R0 + R1 / (1 + 1j * omega * R1 * C1)

        result = equivalent_circuit_fit(
            freq, Z.real, Z.imag,
            circuit_string="R0-p(R1,C1)",
            initial_guess=[50, 30, 1e-5],
        )
        params = dict(zip(result["param_names"], result["param_values"]))
        assert abs(params["R0"] - R0) / R0 < 0.05
        assert abs(params["R1"] - R1) / R1 < 0.05
        assert result["residual_rmse"] < 0.01

    def test_fit_on_gamry_data(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        result = equivalent_circuit_fit(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            circuit_string="R0-p(R1,C1)-W1",
            initial_guess=[800, 10000, 1e-9, 5000],
        )
        assert result["residual_rmse"] < 0.5

    def test_cpe_circuit(self):
        """Test a circuit with CPE element."""
        r = load(_path("eis", "exampleData.csv"))
        result = equivalent_circuit_fit(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            circuit_string="R0-p(R1,CPE1)",
            initial_guess=[0.01, 0.01, 1.0, 0.8],
        )
        assert len(result["param_values"]) == 4
        assert result["residual_rmse"] < 0.5

    def test_constants(self):
        """Test holding a parameter constant during fit."""
        r = load(_path("eis", "exampleData.csv"))
        result = equivalent_circuit_fit(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            circuit_string="R0-p(R1,C1)-W1",
            initial_guess=[0.01, 100, 0.01],
            constants={"R0": 0.015},
        )
        assert len(result["param_values"]) == 3


# ---- Kramers-Kronig validation via impedance.py ----

class TestKramersKronig:
    def test_on_eis_csv(self):
        r = load(_path("eis", "exampleData.csv"))
        result = kramers_kronig_validation(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
        )
        assert "M" in result
        assert "mu" in result
        assert "valid" in result
        assert isinstance(result["M"], int)
        assert result["M"] > 0
        assert len(result["resids_real"]) == len(r.data)

    def test_on_gamry(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        result = kramers_kronig_validation(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
        )
        assert result["M"] > 0


# ---- DRT via pyDRTtools ----

class TestDRT:
    def test_simple_on_real_data(self):
        r = load(_path("eis", "exampleData.csv"))
        result = drt_analysis(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            method="simple",
        )
        assert result["method"] == "simple"
        assert len(result["tau"]) > 0
        assert len(result["gamma"]) > 0
        assert result["R_inf"] is not None

    def test_simple_on_gamry(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        result = drt_analysis(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            method="simple",
        )
        assert len(result["tau"]) > 0
        assert np.max(result["gamma"]) > 0

    def test_bayesian(self):
        r = load(_path("eis", "exampleData.csv"))
        result = drt_analysis(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            method="bayesian",
            NMC_sample=500,  # fewer samples for speed
        )
        assert result["method"] == "bayesian"
        assert "mean" in result
        assert "lower_bound" in result
        assert "upper_bound" in result

    def test_bht(self):
        r = load(_path("eis", "exampleData.csv"))
        result = drt_analysis(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            method="BHT",
        )
        assert result["method"] == "BHT"
        assert "scores" in result

    def test_peak_analysis(self):
        r = load(_path("eis", "exampleData.csv"))
        result = drt_peak_analysis(
            r.data["frequency_hz"].values,
            r.data["z_real_ohm"].values,
            r.data["z_imag_ohm"].values,
            n_peaks=2,
        )
        assert len(result["tau"]) > 0
        assert len(result["gamma"]) > 0
        assert result["n_peaks"] == 2


# ---- Cross-validation (from test_parsers, kept here for completeness) ----

class TestCrossValidation:
    def test_galvani_vs_navani_voltage(self):
        r_galvani = load(_path("biologic", "navani_gcpl.mpr"))
        import navani.echem as ec
        df_navani = ec.echem_file_loader(_path("biologic", "navani_gcpl.mpr"))
        v_diff = np.abs(
            r_galvani.data["voltage_v"].values.astype(float)
            - df_navani["Voltage"].values.astype(float)
        )
        assert v_diff.max() < 1e-3
