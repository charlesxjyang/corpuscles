"""Tests for echem_parse parsers against real instrument data files."""

import os
import sys
import pytest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from echem_parse import load, FileType
from echem_parse.core import detect_file_type, ExperimentType

TEST_DATA = os.path.join(os.path.dirname(__file__), "..", "..", "test_data")


def _path(subdir, filename):
    return os.path.join(TEST_DATA, subdir, filename)


# ---- File type detection ----

class TestDetection:
    def test_biologic_mpr(self):
        assert detect_file_type(_path("biologic", "v1150_PEIS.mpr")) == FileType.BIOLOGIC_MPR

    def test_neware_nda(self):
        assert detect_file_type(_path("neware", "test.nda")) == FileType.NEWARE_NDA

    def test_neware_ndax(self):
        assert detect_file_type(_path("neware", "test.ndax")) == FileType.NEWARE_NDAX

    def test_gamry_dta(self):
        assert detect_file_type(_path("gamry", "exampleDataGamry.DTA")) == FileType.GAMRY_DTA

    def test_maccor_txt(self):
        assert detect_file_type(_path("maccor", "BG_Maccor_Testdata - 079.txt")) == FileType.MACCOR_TXT

    def test_arbin_csv(self):
        assert detect_file_type(_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv")) == FileType.ARBIN_CSV

    def test_eis_csv(self):
        assert detect_file_type(_path("eis", "exampleData.csv")) == FileType.EIS_CSV


# ---- Biologic .mpr parsing ----

class TestBiologicMPR:
    def test_peis_loads(self):
        r = load(_path("biologic", "v1150_PEIS.mpr"))
        assert r.file_type == FileType.BIOLOGIC_MPR
        assert r.experiment_type == ExperimentType.EIS
        assert len(r.data) > 0

    def test_peis_has_eis_columns(self):
        r = load(_path("biologic", "v1150_PEIS.mpr"))
        assert "frequency_hz" in r.data.columns
        assert "z_real_ohm" in r.data.columns
        assert "z_imag_ohm" in r.data.columns

    def test_peis_frequency_range(self):
        r = load(_path("biologic", "v1150_PEIS.mpr"))
        assert r.data["frequency_hz"].min() > 1  # At least 1 Hz
        assert r.data["frequency_hz"].max() > 1e4  # Up to >10 kHz

    def test_peis_impedance_reasonable(self):
        r = load(_path("biologic", "v1150_PEIS.mpr"))
        assert r.data["z_real_ohm"].min() > 0  # Real Z always positive
        assert r.data["z_imag_ohm"].max() < 0  # Imaginary Z negative (capacitive)

    def test_geis_loads(self):
        r = load(_path("biologic", "v1150_GEIS.mpr"))
        assert r.experiment_type == ExperimentType.EIS
        assert "frequency_hz" in r.data.columns

    def test_gcpl_cycling(self):
        r = load(_path("biologic", "v1150_GCPL.mpr"))
        assert r.experiment_type == ExperimentType.CYCLING
        assert "voltage_v" in r.data.columns
        assert "capacity_ah" in r.data.columns

    def test_gcpl_voltage_reasonable(self):
        """GCPL voltage should be in a reasonable range."""
        r = load(_path("biologic", "v1150_GCPL.mpr"))
        assert r.data["voltage_v"].min() > -5  # No crazy voltage
        assert r.data["voltage_v"].max() < 10

    def test_large_gcpl(self):
        r = load(_path("biologic", "navani_gcpl.mpr"))
        assert len(r.data) > 40000
        assert r.data["voltage_v"].min() >= 1.9
        assert r.data["voltage_v"].max() <= 3.9

    def test_cv_detection(self):
        r = load(_path("biologic", "CV_C01.mpr"))
        assert r.experiment_type == ExperimentType.CV

    def test_ocv_detection(self):
        r = load(_path("biologic", "v1150_OCV.mpr"))
        assert r.experiment_type == ExperimentType.OCV

    def test_timestamp_metadata(self):
        r = load(_path("biologic", "v1150_PEIS.mpr"))
        assert "timestamp" in r.metadata


# ---- Neware parsing ----

class TestNeware:
    def test_nda_loads(self):
        r = load(_path("neware", "test.nda"))
        assert r.file_type == FileType.NEWARE_NDA
        assert r.experiment_type == ExperimentType.CYCLING

    def test_nda_columns(self):
        r = load(_path("neware", "test.nda"))
        assert "voltage_v" in r.data.columns
        assert "current_a" in r.data.columns
        assert "cycle_number" in r.data.columns

    def test_ndax_loads(self):
        r = load(_path("neware", "test.ndax"))
        assert r.file_type == FileType.NEWARE_NDAX
        assert len(r.data) > 1000

    def test_ndax_voltage_range(self):
        r = load(_path("neware", "test.ndax"))
        assert r.data["voltage_v"].min() >= 0.5
        assert r.data["voltage_v"].max() <= 5.0


# ---- Gamry .DTA parsing ----

class TestGamry:
    def test_loads(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        assert r.file_type == FileType.GAMRY_DTA
        assert r.experiment_type == ExperimentType.EIS

    def test_eis_columns(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        assert "frequency_hz" in r.data.columns
        assert "z_real_ohm" in r.data.columns
        assert "z_imag_ohm" in r.data.columns

    def test_frequency_range(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        assert r.data["frequency_hz"].min() < 1  # Sub-Hz
        assert r.data["frequency_hz"].max() > 1e5  # > 100 kHz

    def test_metadata(self):
        r = load(_path("gamry", "exampleDataGamry.DTA"))
        assert r.metadata.get("instrument") == "REF3000-34128"


# ---- Maccor parsing ----

class TestMaccor:
    def test_loads(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        assert r.file_type == FileType.MACCOR_TXT
        assert r.experiment_type == ExperimentType.CYCLING

    def test_cycling_columns(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        for col in ["voltage_v", "current_a", "capacity_ah", "cycle_number", "time_s"]:
            assert col in r.data.columns, f"Missing {col}"

    def test_voltage_reasonable(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        assert r.data["voltage_v"].min() > 0
        assert r.data["voltage_v"].max() < 5

    def test_temperature_present(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        assert "temperature_c" in r.data.columns
        assert r.data["temperature_c"].min() > 10
        assert r.data["temperature_c"].max() < 100

    def test_metadata(self):
        r = load(_path("maccor", "BG_Maccor_Testdata - 079.txt"))
        assert "test_date" in r.metadata


# ---- Arbin CSV parsing ----

class TestArbin:
    def test_loads(self):
        r = load(_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv"))
        assert r.file_type == FileType.ARBIN_CSV
        assert r.experiment_type == ExperimentType.CYCLING

    def test_cycling_columns(self):
        r = load(_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv"))
        for col in ["voltage_v", "current_a", "cycle_number", "time_s"]:
            assert col in r.data.columns, f"Missing {col}"

    def test_voltage_reasonable(self):
        r = load(_path("arbin", "BG_Arbin_MBC5v2_Cell_Cell6_Channel_25_Wb_1.csv"))
        assert r.data["voltage_v"].min() > 0
        assert r.data["voltage_v"].max() < 5


# ---- EIS CSV parsing ----

class TestEISCSV:
    def test_loads(self):
        r = load(_path("eis", "exampleData.csv"))
        assert r.file_type == FileType.EIS_CSV
        assert r.experiment_type == ExperimentType.EIS

    def test_eis_columns(self):
        r = load(_path("eis", "exampleData.csv"))
        assert "frequency_hz" in r.data.columns
        assert "z_real_ohm" in r.data.columns
        assert "z_imag_ohm" in r.data.columns

    def test_frequency_positive(self):
        r = load(_path("eis", "exampleData.csv"))
        assert (r.data["frequency_hz"] > 0).all()


# ---- Cross-validation ----

class TestCrossValidation:
    def test_galvani_vs_navani_voltage(self):
        """Galvani and navani should produce identical voltages for the same .mpr."""
        r_galvani = load(_path("biologic", "navani_gcpl.mpr"))
        import navani.echem as ec
        df_navani = ec.echem_file_loader(_path("biologic", "navani_gcpl.mpr"))
        v_diff = np.abs(
            r_galvani.data["voltage_v"].values.astype(float)
            - df_navani["Voltage"].values.astype(float)
        )
        assert v_diff.max() < 1e-3, f"Max voltage diff: {v_diff.max()}"
