"""Verify FluxFast release distributions against their source manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import tarfile
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
from pathlib import Path, PurePosixPath
from typing import Any

import tomllib

_STABLE_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_MAX_ARCHIVE_FILES = 5_000
_MAX_ARCHIVE_ENTRY_BYTES = 25 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


class ArtifactVerificationError(ValueError):
    """A built distribution does not match the frozen release contract."""


@dataclass(frozen=True)
class ArchiveFile:
    data: bytes
    mode: int


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise ArtifactVerificationError(message)


def _safe_archive_name(name: str, *, archive: Path) -> None:
    path = PurePosixPath(name)
    candidate = name.removesuffix("/")
    _expect(bool(name), f"{archive.name}: empty archive path")
    _expect(not name.startswith("/"), f"{archive.name}: absolute path {name!r}")
    _expect("\\" not in name, f"{archive.name}: non-POSIX path {name!r}")
    _expect(".." not in path.parts, f"{archive.name}: parent path {name!r}")
    _expect(
        path.as_posix() == candidate and candidate not in {"", "."},
        f"{archive.name}: non-canonical path {name!r}",
    )


def _bounded_file_count(count: int, *, archive: Path) -> None:
    _expect(
        count <= _MAX_ARCHIVE_FILES,
        f"{archive.name}: more than {_MAX_ARCHIVE_FILES} archive entries",
    )


def _bounded_file_size(size: int, *, archive: Path, name: str) -> None:
    _expect(
        size <= _MAX_ARCHIVE_ENTRY_BYTES,
        f"{archive.name}: {name!r} exceeds the per-file size limit",
    )


def _read_tar_files(path: Path) -> dict[str, ArchiveFile]:
    files: dict[str, ArchiveFile] = {}
    total_size = 0
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            members = archive.getmembers()
            _bounded_file_count(len(members), archive=path)
            for member in members:
                _safe_archive_name(member.name, archive=path)
                if member.isdir():
                    continue
                _expect(
                    member.isfile(),
                    f"{path.name}: links and special entries are forbidden ({member.name!r})",
                )
                _expect(
                    member.name not in files,
                    f"{path.name}: duplicate archive path {member.name!r}",
                )
                _bounded_file_size(member.size, archive=path, name=member.name)
                total_size += member.size
                _expect(
                    total_size <= _MAX_ARCHIVE_BYTES,
                    f"{path.name}: expanded archive exceeds the size limit",
                )
                extracted = archive.extractfile(member)
                _expect(extracted is not None, f"{path.name}: cannot read {member.name!r}")
                files[member.name] = ArchiveFile(extracted.read(), member.mode)
    except (OSError, tarfile.TarError) as error:
        raise ArtifactVerificationError(f"{path.name}: invalid gzip tar archive") from error
    return files


def _read_zip_files(path: Path) -> dict[str, ArchiveFile]:
    files: dict[str, ArchiveFile] = {}
    total_size = 0
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        raise ArtifactVerificationError(f"{path.name}: invalid wheel archive") from error

    with archive:
        entries = archive.infolist()
        _bounded_file_count(len(entries), archive=path)
        for entry in entries:
            _safe_archive_name(entry.filename, archive=path)
            if entry.is_dir():
                continue
            file_type = stat.S_IFMT(entry.external_attr >> 16)
            _expect(
                file_type in {0, stat.S_IFREG},
                f"{path.name}: special entries are forbidden ({entry.filename!r})",
            )
            _expect(
                entry.filename not in files,
                f"{path.name}: duplicate archive path {entry.filename!r}",
            )
            _bounded_file_size(entry.file_size, archive=path, name=entry.filename)
            total_size += entry.file_size
            _expect(
                total_size <= _MAX_ARCHIVE_BYTES,
                f"{path.name}: expanded archive exceeds the size limit",
            )
            files[entry.filename] = ArchiveFile(
                archive.read(entry),
                (entry.external_attr >> 16) & 0o777,
            )
    return files


def _canonical_requirement(requirement: str) -> str:
    base, separator, marker = requirement.partition(";")
    match = re.fullmatch(r"\s*([A-Za-z0-9_.-]+(?:\[[^]]+\])?)\s*(.*?)\s*", base)
    _expect(match is not None, f"cannot normalize requirement {requirement!r}")
    name = match.group(1).lower().replace("_", "-")
    specifier = match.group(2)
    if specifier.startswith("@"):  # Direct references are order-sensitive.
        normalized_specifier = re.sub(r"\s+", " ", specifier).strip()
    else:
        normalized_specifier = ",".join(
            sorted(part.strip() for part in specifier.split(",") if part.strip())
        )
    if not separator:
        return f"{name}{normalized_specifier}"
    normalized_marker = re.sub(r"\s+", " ", marker.strip()).replace('"', "'")
    return f"{name}{normalized_specifier}; {normalized_marker}"


def _expected_python_requirements(project: dict[str, Any]) -> set[str]:
    requirements = {
        _canonical_requirement(requirement)
        for requirement in project.get("dependencies", [])
    }
    for extra, values in project.get("optional-dependencies", {}).items():
        for requirement in values:
            base, separator, _marker = requirement.partition(";")
            _expect(
                not separator,
                f"optional dependency markers require verifier support: {requirement!r}",
            )
            requirements.add(
                _canonical_requirement(f"{base}; extra == '{extra}'")
            )
    return requirements


def _verify_python_metadata(
    data: bytes,
    *,
    project: dict[str, Any],
    readme: bytes,
    version: str,
    label: str,
) -> None:
    message = BytesParser(policy=policy.default).parsebytes(data)
    expected_fields = {
        "Name": project["name"],
        "Version": version,
        "Summary": project["description"],
        "Requires-Python": project["requires-python"],
        "License-Expression": project["license"],
    }
    if project.get("authors"):
        expected_fields["Author"] = project["authors"][0]["name"]
    for field, expected in expected_fields.items():
        _expect(
            message.get(field) == expected,
            f"{label}: {field} metadata does not match {expected!r}",
        )

    expected_urls = {
        f"{name}, {url}" for name, url in project.get("urls", {}).items()
    }
    _expect(
        set(message.get_all("Project-URL", [])) == expected_urls,
        f"{label}: project URLs do not match pyproject.toml",
    )
    _expect(
        set(message.get_all("Provides-Extra", []))
        == set(project.get("optional-dependencies", {})),
        f"{label}: optional dependency names do not match pyproject.toml",
    )
    actual_requirements = {
        _canonical_requirement(requirement)
        for requirement in message.get_all("Requires-Dist", [])
    }
    _expect(
        actual_requirements == _expected_python_requirements(project),
        f"{label}: dependencies do not match pyproject.toml",
    )
    payload = message.get_payload()
    _expect(isinstance(payload, str), f"{label}: README payload is not text")
    _expect(
        payload.strip().encode() == readme.strip(),
        f"{label}: embedded README does not match the package README",
    )


def _source_python_files(repository_root: Path) -> set[str]:
    source = repository_root / "python/fluxfast/src"
    return {
        path.relative_to(source).as_posix()
        for path in source.rglob("*.py")
        if path.is_file()
    }


def _verify_wheel(
    path: Path,
    *,
    repository_root: Path,
    project: dict[str, Any],
    version: str,
) -> None:
    files = _read_zip_files(path)
    dist_info = f"fluxfast-{version}.dist-info"
    required = {
        "fluxfast/__init__.py",
        "fluxfast/cli.py",
        f"{dist_info}/METADATA",
        f"{dist_info}/WHEEL",
        f"{dist_info}/entry_points.txt",
        f"{dist_info}/licenses/LICENSE",
        f"{dist_info}/RECORD",
    }
    _expect(required <= files.keys(), f"{path.name}: required wheel files are missing")
    _expect(
        all(name.startswith(("fluxfast/", f"{dist_info}/")) for name in files),
        f"{path.name}: wheel contains files outside the package and dist-info roots",
    )
    actual_sources = {name for name in files if name.startswith("fluxfast/")}
    _expect(
        actual_sources == _source_python_files(repository_root),
        f"{path.name}: packaged Python sources do not match python/fluxfast/src",
    )

    package_root = repository_root / "python/fluxfast"
    readme = (package_root / "README.md").read_bytes()
    license_text = (package_root / "LICENSE").read_bytes()
    _expect(
        files[f"{dist_info}/licenses/LICENSE"].data == license_text,
        f"{path.name}: LICENSE does not match the source package",
    )
    entry_points = files[f"{dist_info}/entry_points.txt"].data.decode()
    _expect(
        "fluxfast = fluxfast.cli:main" in entry_points,
        f"{path.name}: fluxfast console entry point is missing",
    )
    _verify_python_metadata(
        files[f"{dist_info}/METADATA"].data,
        project=project,
        readme=readme,
        version=version,
        label=path.name,
    )


def _verify_sdist(
    path: Path,
    *,
    repository_root: Path,
    project: dict[str, Any],
    version: str,
) -> None:
    files = _read_tar_files(path)
    root = f"fluxfast-{version}"
    _expect(
        all(name.startswith(f"{root}/") for name in files),
        f"{path.name}: every sdist file must be below {root}/",
    )
    required = {
        f"{root}/LICENSE",
        f"{root}/README.md",
        f"{root}/pyproject.toml",
        f"{root}/PKG-INFO",
        f"{root}/src/fluxfast/__init__.py",
        f"{root}/src/fluxfast/cli.py",
    }
    _expect(required <= files.keys(), f"{path.name}: required sdist files are missing")
    forbidden_parts = {".git", ".venv", "node_modules", "__pycache__"}
    _expect(
        all(
            not (forbidden_parts & set(PurePosixPath(name).parts))
            and not name.endswith((".pyc", ".pyo"))
            for name in files
        ),
        f"{path.name}: sdist contains a forbidden development artifact",
    )

    package_root = repository_root / "python/fluxfast"
    for name in ("LICENSE", "README.md", "pyproject.toml"):
        _expect(
            files[f"{root}/{name}"].data == (package_root / name).read_bytes(),
            f"{path.name}: {name} does not match the source package",
        )
    expected_sources = {
        f"{root}/src/{name}" for name in _source_python_files(repository_root)
    }
    actual_sources = {
        name for name in files if name.startswith(f"{root}/src/fluxfast/")
    }
    _expect(
        actual_sources == expected_sources,
        f"{path.name}: packaged Python sources do not match python/fluxfast/src",
    )
    _verify_python_metadata(
        files[f"{root}/PKG-INFO"].data,
        project=project,
        readme=(package_root / "README.md").read_bytes(),
        version=version,
        label=path.name,
    )


def _runtime_targets(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _runtime_targets(child)


def _source_tree_files(root: Path, prefix: str) -> set[str]:
    _expect(root.is_dir(), f"missing built package directory: {root}")
    return {
        f"package/{prefix}/{path.relative_to(root).as_posix()}"
        for path in root.rglob("*")
        if path.is_file()
    }


def _verify_npm_package(
    path: Path,
    *,
    repository_root: Path,
    package_directory: str,
    package_name: str,
    version: str,
) -> None:
    files = _read_tar_files(path)
    package_root = repository_root / package_directory
    source_manifest = json.loads((package_root / "package.json").read_text())
    required = {"package/package.json", "package/README.md", "package/LICENSE"}
    _expect(required <= files.keys(), f"{path.name}: package metadata files are missing")
    _expect(
        all(name.startswith("package/") for name in files),
        f"{path.name}: every npm file must be below package/",
    )

    packed_manifest = json.loads(files["package/package.json"].data)
    frozen_fields = (
        "name",
        "version",
        "license",
        "description",
        "repository",
        "homepage",
        "bugs",
        "engines",
        "publishConfig",
        "main",
        "module",
        "types",
        "sideEffects",
        "files",
        "bin",
        "exports",
        "dependencies",
        "peerDependencies",
    )
    for field in frozen_fields:
        _expect(
            packed_manifest.get(field) == source_manifest.get(field),
            f"{path.name}: packed {field} does not match package.json",
        )
    _expect(packed_manifest["name"] == package_name, f"{path.name}: wrong package name")
    _expect(packed_manifest["version"] == version, f"{path.name}: wrong version")

    _expect(
        files["package/README.md"].data == (package_root / "README.md").read_bytes(),
        f"{path.name}: README.md does not match the source package",
    )
    _expect(
        files["package/LICENSE"].data == (package_root / "LICENSE").read_bytes(),
        f"{path.name}: LICENSE does not match the source package",
    )

    expected_files = required | _source_tree_files(package_root / "dist", "dist")
    if (package_root / "bin").is_dir():
        expected_files |= _source_tree_files(package_root / "bin", "bin")
    _expect(
        set(files) == expected_files,
        f"{path.name}: archive contents do not match package.json files and built output",
    )

    declared_targets = set(_runtime_targets(packed_manifest.get("exports", {})))
    for field in ("main", "module", "types"):
        target = packed_manifest.get(field)
        if target:
            declared_targets.add(target)
    for target in packed_manifest.get("bin", {}).values():
        declared_targets.add(target)
    for target in declared_targets:
        target_path = PurePosixPath(target)
        _expect(
            not target.startswith("/") and ".." not in target_path.parts,
            f"{path.name}: unsafe package target {target!r}",
        )
        archive_name = f"package/{target.removeprefix('./')}"
        _expect(archive_name in files, f"{path.name}: missing declared target {target!r}")
    for target in packed_manifest.get("bin", {}).values():
        archive_name = f"package/{target.removeprefix('./')}"
        _expect(
            files[archive_name].mode & 0o111 != 0,
            f"{path.name}: command target {target!r} is not executable",
        )


def _artifact_paths(release_dir: Path, version: str) -> tuple[Path, ...]:
    expected = (
        release_dir / "python" / f"fluxfast-{version}-py3-none-any.whl",
        release_dir / "python" / f"fluxfast-{version}.tar.gz",
        release_dir / "npm" / f"fluxfast-core-{version}.tgz",
        release_dir / "npm" / f"fluxfast-next-{version}.tgz",
    )
    observed = {
        path
        for directory in (release_dir / "python", release_dir / "npm")
        if directory.is_dir()
        for path in directory.rglob("*")
        if path.is_file()
    }
    _expect(
        observed == set(expected),
        "release directory must contain exactly the wheel, sdist, Core tarball, and Next tarball",
    )
    for path in expected:
        _expect(
            path.stat().st_size <= _MAX_ARCHIVE_BYTES,
            f"{path.name}: distribution exceeds the size limit",
        )
    return expected


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        while chunk := artifact.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write_checksums(paths: Iterable[Path], output: Path) -> None:
    lines = [f"{_sha256(path)}  {path.name}" for path in paths]
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text("\n".join(lines) + "\n")
    temporary.replace(output)


def verify_release_artifacts(
    *,
    release_dir: Path,
    repository_root: Path,
    version: str,
    write_checksums: bool = False,
) -> tuple[Path, ...]:
    """Verify all four distributions and optionally write ``SHA256SUMS``."""

    _expect(bool(_STABLE_VERSION.fullmatch(version)), "version must be MAJOR.MINOR.PATCH")
    release_dir = release_dir.resolve()
    repository_root = repository_root.resolve()
    wheel, sdist, core, next_package = _artifact_paths(release_dir, version)
    pyproject = tomllib.loads(
        (repository_root / "python/fluxfast/pyproject.toml").read_text()
    )["project"]
    _expect(pyproject["name"] == "fluxfast", "pyproject.toml: wrong project name")
    _expect(pyproject["version"] == version, "pyproject.toml: wrong project version")

    _verify_wheel(
        wheel,
        repository_root=repository_root,
        project=pyproject,
        version=version,
    )
    _verify_sdist(
        sdist,
        repository_root=repository_root,
        project=pyproject,
        version=version,
    )
    _verify_npm_package(
        core,
        repository_root=repository_root,
        package_directory="packages/core",
        package_name="@fluxfast/core",
        version=version,
    )
    _verify_npm_package(
        next_package,
        repository_root=repository_root,
        package_directory="packages/next",
        package_name="@fluxfast/next",
        version=version,
    )
    artifacts = (wheel, sdist, core, next_package)
    if write_checksums:
        _write_checksums(artifacts, release_dir / "SHA256SUMS")
    return artifacts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--repository-root", type=Path, default=Path(__file__).parents[1])
    parser.add_argument("--version", required=True)
    parser.add_argument("--write-checksums", action="store_true")
    arguments = parser.parse_args()
    try:
        artifacts = verify_release_artifacts(
            release_dir=arguments.release_dir,
            repository_root=arguments.repository_root,
            version=arguments.version,
            write_checksums=arguments.write_checksums,
        )
    except (ArtifactVerificationError, KeyError, OSError, UnicodeError, ValueError) as error:
        print(f"release artifact verification failed: {error}")
        return 1

    for artifact in artifacts:
        print(f"verified {artifact.name}")
    if arguments.write_checksums:
        print(f"wrote {(arguments.release_dir / 'SHA256SUMS').resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
