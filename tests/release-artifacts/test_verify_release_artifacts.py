from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _load_verifier() -> ModuleType:
    path = REPOSITORY_ROOT / "scripts/verify_release_artifacts.py"
    spec = importlib.util.spec_from_file_location("release_artifact_verifier", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verifier = _load_verifier()


def _write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)


def _python_metadata(version: str, readme: str) -> bytes:
    return (
        f"""Metadata-Version: 2.4
Name: fluxfast
Version: {version}
Summary: Test FluxFast package
Project-URL: Homepage, https://example.invalid/fluxfast
Author: FluxFast Contributors
License-Expression: MIT
Requires-Python: >=3.11
Requires-Dist: anyio>=4.0.0
Requires-Dist: fastapi<1.0.0,>=0.141.1
Provides-Extra: redis
Requires-Dist: redis<9.0.0,>=5.0.0; extra == 'redis'
Description-Content-Type: text/markdown

{readme}"""
    ).encode()


def _add_tar_file(
    archive: tarfile.TarFile,
    name: str,
    content: bytes,
    *,
    mode: int = 0o644,
) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(content)
    info.mode = mode
    archive.addfile(info, io.BytesIO(content))


def _build_python_archives(repository: Path, release: Path, version: str) -> None:
    package_root = repository / "python/fluxfast"
    readme = "# FluxFast test package\n"
    pyproject = f"""[project]
name = "fluxfast"
version = "{version}"
description = "Test FluxFast package"
readme = "README.md"
requires-python = ">=3.11"
license = "MIT"
authors = [{{ name = "FluxFast Contributors" }}]
dependencies = [
  "fastapi>=0.141.1,<1.0.0",
  "anyio>=4.0.0",
]

[project.urls]
Homepage = "https://example.invalid/fluxfast"

[project.scripts]
fluxfast = "fluxfast.cli:main"

[project.optional-dependencies]
redis = ["redis>=5.0.0,<9.0.0"]
"""
    _write(package_root / "pyproject.toml", pyproject)
    _write(package_root / "README.md", readme)
    _write(package_root / "LICENSE", "MIT test license\n")
    _write(package_root / "src/fluxfast/__init__.py", "__version__ = 'test'\n")
    _write(package_root / "src/fluxfast/cli.py", "def main():\n    return 0\n")

    metadata = _python_metadata(version, readme)
    dist_info = f"fluxfast-{version}.dist-info"
    wheel = release / "python" / f"fluxfast-{version}-py3-none-any.whl"
    wheel.parent.mkdir(parents=True)
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("fluxfast/__init__.py", "__version__ = 'test'\n")
        archive.writestr("fluxfast/cli.py", "def main():\n    return 0\n")
        archive.writestr(f"{dist_info}/METADATA", metadata)
        archive.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\n")
        archive.writestr(
            f"{dist_info}/entry_points.txt",
            "[console_scripts]\nfluxfast = fluxfast.cli:main\n",
        )
        archive.writestr(f"{dist_info}/licenses/LICENSE", "MIT test license\n")
        archive.writestr(f"{dist_info}/RECORD", "")

    sdist = release / "python" / f"fluxfast-{version}.tar.gz"
    root = f"fluxfast-{version}"
    with tarfile.open(sdist, "w:gz") as archive:
        _add_tar_file(archive, f"{root}/pyproject.toml", pyproject.encode())
        _add_tar_file(archive, f"{root}/README.md", readme.encode())
        _add_tar_file(archive, f"{root}/LICENSE", b"MIT test license\n")
        _add_tar_file(archive, f"{root}/PKG-INFO", metadata)
        _add_tar_file(
            archive,
            f"{root}/src/fluxfast/__init__.py",
            b"__version__ = 'test'\n",
        )
        _add_tar_file(
            archive,
            f"{root}/src/fluxfast/cli.py",
            b"def main():\n    return 0\n",
        )


def _package_manifest(name: str, version: str, *, next_package: bool) -> dict:
    manifest = {
        "name": name,
        "version": version,
        "license": "MIT",
        "description": f"Test {name}",
        "repository": {"type": "git", "url": "https://example.invalid/repo.git"},
        "homepage": "https://example.invalid/fluxfast",
        "bugs": {"url": "https://example.invalid/issues"},
        "engines": {"node": "^22.0.0 || ^24.0.0"},
        "publishConfig": {
            "access": "public",
            "registry": "https://registry.npmjs.org/",
        },
        "main": "./dist/index.js",
        "module": "./dist/esm/index.js",
        "types": "./dist/index.d.ts",
        "sideEffects": False,
        "files": ["bin", "dist"] if next_package else ["dist"],
        "exports": {
            ".": {
                "types": "./dist/index.d.ts",
                "import": "./dist/esm/index.js",
                "require": "./dist/index.js",
                "default": "./dist/index.js",
            }
        },
    }
    if next_package:
        manifest["bin"] = {"fluxfast": "bin/fluxfast.js"}
        manifest["dependencies"] = {"@fluxfast/core": f"^{version}"}
        manifest["peerDependencies"] = {
            "next": ">=16.3.0 <17.0.0",
            "react": ">=19.0.0",
            "react-dom": ">=19.0.0",
        }
    return manifest


def _build_npm_archive(
    repository: Path,
    release: Path,
    version: str,
    *,
    package: str,
    next_package: bool,
    packed_name: str | None = None,
    add_link: bool = False,
) -> None:
    package_root = repository / "packages" / package
    name = "@fluxfast/next" if next_package else "@fluxfast/core"
    manifest = _package_manifest(name, version, next_package=next_package)
    _write(package_root / "package.json", json.dumps(manifest))
    _write(package_root / "README.md", f"# {name}\n")
    _write(package_root / "LICENSE", "MIT test license\n")
    _write(package_root / "dist/index.js", "module.exports = {};\n")
    _write(package_root / "dist/index.d.ts", "export {};\n")
    _write(package_root / "dist/esm/index.js", "export {};\n")
    if next_package:
        _write(package_root / "bin/fluxfast.js", "#!/usr/bin/env node\n")

    packed_manifest = dict(manifest)
    if packed_name is not None:
        packed_manifest["name"] = packed_name
    archive_path = release / "npm" / f"fluxfast-{package}-{version}.tgz"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz") as archive:
        files = {
            "package/package.json": json.dumps(packed_manifest).encode(),
            "package/README.md": (package_root / "README.md").read_bytes(),
            "package/LICENSE": (package_root / "LICENSE").read_bytes(),
            "package/dist/index.js": (package_root / "dist/index.js").read_bytes(),
            "package/dist/index.d.ts": (package_root / "dist/index.d.ts").read_bytes(),
            "package/dist/esm/index.js": (
                package_root / "dist/esm/index.js"
            ).read_bytes(),
        }
        if next_package:
            files["package/bin/fluxfast.js"] = (
                package_root / "bin/fluxfast.js"
            ).read_bytes()
        for name_in_archive, content in files.items():
            mode = 0o755 if name_in_archive.endswith("bin/fluxfast.js") else 0o644
            _add_tar_file(archive, name_in_archive, content, mode=mode)
        if add_link:
            link = tarfile.TarInfo("package/dist/unsafe.js")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            archive.addfile(link)


def _build_release(
    root: Path,
    *,
    packed_core_name: str | None = None,
    core_link: bool = False,
) -> tuple[Path, Path, str]:
    repository = root / "repository"
    release = root / "release"
    version = "0.9.0"
    _build_python_archives(repository, release, version)
    _build_npm_archive(
        repository,
        release,
        version,
        package="core",
        next_package=False,
        packed_name=packed_core_name,
        add_link=core_link,
    )
    _build_npm_archive(
        repository,
        release,
        version,
        package="next",
        next_package=True,
    )
    return repository, release, version


def test_verifies_all_distributions_and_writes_checksums(tmp_path: Path) -> None:
    repository, release, version = _build_release(tmp_path)

    artifacts = verifier.verify_release_artifacts(
        release_dir=release,
        repository_root=repository,
        version=version,
        write_checksums=True,
    )

    assert len(artifacts) == 4
    checksum_lines = (release / "SHA256SUMS").read_text().splitlines()
    assert [line.split("  ", 1)[1] for line in checksum_lines] == [
        path.name for path in artifacts
    ]
    for line, artifact in zip(checksum_lines, artifacts, strict=True):
        assert line.split("  ", 1)[0] == hashlib.sha256(artifact.read_bytes()).hexdigest()


def test_rejects_an_extra_artifact(tmp_path: Path) -> None:
    repository, release, version = _build_release(tmp_path)
    _write(release / "npm/debug.txt", "not a distribution")

    with pytest.raises(
        verifier.ArtifactVerificationError,
        match="exactly the wheel, sdist, Core tarball, and Next tarball",
    ):
        verifier.verify_release_artifacts(
            release_dir=release,
            repository_root=repository,
            version=version,
        )


def test_rejects_a_missing_artifact(tmp_path: Path) -> None:
    repository, release, version = _build_release(tmp_path)
    (release / "python" / f"fluxfast-{version}.tar.gz").unlink()

    with pytest.raises(
        verifier.ArtifactVerificationError,
        match="exactly the wheel, sdist, Core tarball, and Next tarball",
    ):
        verifier.verify_release_artifacts(
            release_dir=release,
            repository_root=repository,
            version=version,
        )


def test_rejects_packed_metadata_drift(tmp_path: Path) -> None:
    repository, release, version = _build_release(
        tmp_path,
        packed_core_name="@fluxfast/wrong",
    )

    with pytest.raises(
        verifier.ArtifactVerificationError,
        match="packed name does not match package.json",
    ):
        verifier.verify_release_artifacts(
            release_dir=release,
            repository_root=repository,
            version=version,
        )


def test_rejects_links_in_distribution_archives(tmp_path: Path) -> None:
    repository, release, version = _build_release(tmp_path, core_link=True)

    with pytest.raises(
        verifier.ArtifactVerificationError,
        match="links and special entries are forbidden",
    ):
        verifier.verify_release_artifacts(
            release_dir=release,
            repository_root=repository,
            version=version,
        )
