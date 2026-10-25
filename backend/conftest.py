"""Point the store at a throwaway database before backend.main is imported."""

import os
import tempfile
from pathlib import Path

TEST_DB_DIR = Path(tempfile.mkdtemp(prefix="invisible-worker-tests-"))
os.environ["INVISIBLE_WORKER_DB"] = str(TEST_DB_DIR / "test.db")
