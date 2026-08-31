"""Tests for isolated Redis cache namespaces and opaque keys."""

import re

import pytest

from fluxfast._redis_cache_keys import (
    MAX_REDIS_CACHE_NAMESPACE_LENGTH,
    REDIS_CACHE_KEY_PREFIX,
    RedisCacheKeyspace,
)


def test_keyspace_accepts_documented_namespace_characters():
    keyspace = RedisCacheKeyspace("Hotel-PROD_1:blue.green")

    assert keyspace.namespace == "Hotel-PROD_1:blue.green"
    assert keyspace.prefix == (
        f"{REDIS_CACHE_KEY_PREFIX}:Hotel-PROD_1%3Ablue.green"
    )
    assert keyspace.scan_pattern == f"{keyspace.prefix}:*"


def test_keyspace_accepts_maximum_namespace_length():
    namespace = "a" * MAX_REDIS_CACHE_NAMESPACE_LENGTH

    assert RedisCacheKeyspace(namespace).namespace == namespace


@pytest.mark.parametrize(
    "namespace",
    [
        None,
        True,
        1,
        "",
        "hotel prod",
        "hotel/prod",
        "hotel\nprod",
        "酒店",
        "hotel*",
        "hotel?",
        "hotel[prod]",
        "hotel\\prod",
        "a" * (MAX_REDIS_CACHE_NAMESPACE_LENGTH + 1),
    ],
)
def test_keyspace_rejects_unsafe_namespaces(namespace):
    with pytest.raises(ValueError, match="namespace must contain"):
        RedisCacheKeyspace(namespace)


def test_resource_keys_are_deterministic_opaque_and_bounded():
    keyspace = RedisCacheKeyspace("hotel-prod")
    logical_identity = "tenant/private-user:rooms:list?page=1"

    first = keyspace.resource_key(logical_identity)
    second = keyspace.resource_key(logical_identity)

    assert first == second
    assert first.startswith(f"{keyspace.prefix}:resource:")
    assert logical_identity not in first
    assert re.fullmatch(r"[0-9a-f]{64}", first.rsplit(":", 1)[1])
    assert len(first) == len(f"{keyspace.prefix}:resource:") + 64


def test_tag_keys_are_deterministic_opaque_and_distinct_from_resources():
    keyspace = RedisCacheKeyspace("hotel-prod")

    resource_key = keyspace.resource_key("availability")
    tag_key = keyspace.tag_key("availability")

    assert tag_key == keyspace.tag_key("availability")
    assert tag_key.startswith(f"{keyspace.prefix}:tag:")
    assert "availability" not in tag_key
    assert resource_key != tag_key


def test_resource_tag_membership_key_reuses_only_the_opaque_digest():
    keyspace = RedisCacheKeyspace("hotel-prod")
    logical_identity = "tenant:secret::rooms"

    resource_key = keyspace.resource_key(logical_identity)
    membership_key = keyspace.resource_tags_key(logical_identity)

    assert membership_key.startswith(f"{keyspace.prefix}:resource-tags:")
    assert logical_identity not in membership_key
    assert membership_key.rsplit(":", 1)[1] == resource_key.rsplit(":", 1)[1]


def test_key_type_prefixes_are_namespace_local_and_non_overlapping():
    keyspace = RedisCacheKeyspace("hotel:blue")

    assert keyspace.resource_prefix == f"{keyspace.prefix}:resource:"
    assert keyspace.resource_tags_prefix == f"{keyspace.prefix}:resource-tags:"
    assert keyspace.tag_prefix == f"{keyspace.prefix}:tag:"
    assert len(
        {
            keyspace.resource_prefix,
            keyspace.resource_tags_prefix,
            keyspace.tag_prefix,
        }
    ) == 3


@pytest.mark.parametrize("method_name", ["resource_key", "tag_key"])
@pytest.mark.parametrize("value", [None, True, 1, ""])
def test_key_derivation_rejects_empty_or_non_string_values(method_name, value):
    method = getattr(RedisCacheKeyspace("hotel-prod"), method_name)

    with pytest.raises(ValueError, match="non-empty string"):
        method(value)


@pytest.mark.parametrize("method_name", ["resource_key", "tag_key"])
def test_key_derivation_rejects_invalid_utf8(method_name):
    method = getattr(RedisCacheKeyspace("hotel-prod"), method_name)

    with pytest.raises(ValueError, match="valid UTF-8"):
        method("\ud800")


def test_namespaces_isolate_identical_resource_and_tag_values():
    first = RedisCacheKeyspace("hotel-prod")
    second = RedisCacheKeyspace("hotel-staging")

    assert first.resource_key("rooms") != second.resource_key("rooms")
    assert first.tag_key("availability") != second.tag_key("availability")


def test_colon_namespace_does_not_overlap_parent_scan_prefix():
    parent = RedisCacheKeyspace("hotel")
    child = RedisCacheKeyspace("hotel:blue")

    child_resource = child.resource_key("rooms")
    assert not child.prefix.startswith(f"{parent.prefix}:")
    assert not child_resource.startswith(f"{parent.prefix}:")
    assert parent.scan_pattern == f"{REDIS_CACHE_KEY_PREFIX}:hotel:*"


def test_scan_pattern_contains_only_the_namespace_prefix():
    keyspace = RedisCacheKeyspace("hotel-prod")

    assert "resource" not in keyspace.scan_pattern
    assert "tag" not in keyspace.scan_pattern
    assert keyspace.scan_pattern.count("*") == 1
