"""Small schema/2 producer used to verify old JavaScript tooling diagnostics."""

from fastapi import FastAPI
from fluxfast import FluxFast
from pydantic import BaseModel


class CompatibilityContract(BaseModel):
    value: str


app = FastAPI()
FluxFast(app).define_type("CompatibilityContract", CompatibilityContract)
