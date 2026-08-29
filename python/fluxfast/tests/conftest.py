"""Pytest configuration and fixtures for FluxFast."""

import pytest

from fluxfast import MemoryResourceCache


@pytest.fixture
def cache() -> MemoryResourceCache:
    return MemoryResourceCache(max_entries=100)

