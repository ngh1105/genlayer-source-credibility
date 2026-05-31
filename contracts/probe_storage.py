# { "Depends": "py-genlayer:test" }
# probe_storage.py — canonical minimal GenLayer Intelligent Contract.
# Used only to isolate whether the studionet deploy+read flow works at all,
# independent of our larger skeleton contracts.

from genlayer import *


class Storage(gl.Contract):
    storage: str

    def __init__(self, initial: str):
        self.storage = initial

    @gl.public.view
    def get_storage(self) -> str:
        return self.storage

    @gl.public.write
    def update_storage(self, new_value: str) -> None:
        self.storage = new_value
