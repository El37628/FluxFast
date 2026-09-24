"""Install a FluxFast sdist in an isolated environment and verify its CLI."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def _run(command: list[str], *, cwd: Path, environment: dict[str, str]) -> None:
    subprocess.run(command, cwd=cwd, env=environment, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--version", required=True)
    arguments = parser.parse_args()

    artifact = arguments.artifact.resolve(strict=True)
    if artifact.name != f"fluxfast-{arguments.version}.tar.gz":
        raise ValueError(
            f"expected fluxfast-{arguments.version}.tar.gz, received {artifact.name}"
        )
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", arguments.version) is None:
        raise ValueError("version must use the stable MAJOR.MINOR.PATCH format")

    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    environment["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"

    with tempfile.TemporaryDirectory(prefix="fluxfast-sdist-consumer-") as raw_root:
        root = Path(raw_root)
        virtual_environment = root / "venv"
        _run(
            [sys.executable, "-m", "venv", str(virtual_environment)],
            cwd=root,
            environment=environment,
        )
        scripts = virtual_environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        fluxfast = scripts / ("fluxfast.exe" if os.name == "nt" else "fluxfast")

        _run(
            [str(python), "-m", "pip", "install", str(artifact)],
            cwd=root,
            environment=environment,
        )
        import_probe = (
            "import sys; from importlib.metadata import version; from pathlib import Path; "
            "import fluxfast; expected = sys.argv[1]; "
            "assert version('fluxfast') == expected; "
            "assert Path(fluxfast.__file__).resolve().is_relative_to("
            "Path(sys.prefix).resolve())"
        )
        _run(
            [
                str(python),
                "-c",
                import_probe,
                arguments.version,
            ],
            cwd=root,
            environment=environment,
        )
        _run([str(fluxfast), "--help"], cwd=root, environment=environment)

    print(f"Isolated sdist consumer passed for FluxFast {arguments.version}.")


if __name__ == "__main__":
    main()
