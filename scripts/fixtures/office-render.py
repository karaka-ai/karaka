"""Office content checks for installed Python runtime tests."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path


def _windows_file_owners(path: str) -> dict[str, object]:
    """Sample read-only Restart Manager ownership once; never stop or restart applications."""
    import ctypes

    class FileTime(ctypes.Structure):
        _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

    class UniqueProcess(ctypes.Structure):
        _fields_ = [("pid", ctypes.c_uint32), ("started", FileTime)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [("process", UniqueProcess), ("name", ctypes.c_wchar * 256),
                    ("service", ctypes.c_wchar * 64), ("type", ctypes.c_int32),
                    ("status", ctypes.c_uint32), ("session", ctypes.c_uint32), ("restartable", ctypes.c_int32)]

    # restartmanager.h defines DWORD/UINT as 32-bit and the session key as 32 WCHARs plus NUL.
    api = ctypes.WinDLL("rstrtmgr")
    uint = ctypes.c_uint32
    pointer = ctypes.POINTER
    for function, arguments in (
        (api.RmStartSession, [pointer(uint), uint, ctypes.c_wchar_p]),
        (api.RmRegisterResources, [uint, uint, pointer(ctypes.c_wchar_p), uint, pointer(UniqueProcess),
                                   uint, pointer(ctypes.c_wchar_p)]),
        (api.RmGetList, [uint, pointer(uint), pointer(uint), pointer(ProcessInfo), pointer(uint)]),
        (api.RmEndSession, [uint]),
    ):
        function.argtypes = arguments
        function.restype = uint
    session = uint()
    report: dict[str, object] = {"stage": "start", "status": api.RmStartSession(ctypes.byref(session), 0,
                                                                             ctypes.create_unicode_buffer(33))}
    if report["status"] != 0:
        return report
    try:
        files = (ctypes.c_wchar_p * 1)(path)
        report.update(stage="register", status=api.RmRegisterResources(session, 1, files, 0, None, 0, None))
        if report["status"] != 0:
            return report
        needed, count, reasons = uint(), uint(32), uint()
        owners = (ProcessInfo * count.value)()
        status = api.RmGetList(session, ctypes.byref(needed), ctypes.byref(count), owners, ctypes.byref(reasons))
        report.update(stage="list", status=status, needed=needed.value, reboot_reasons=reasons.value)
        if status == 0:
            report["owners"] = [{"pid": entry.process.pid, "name": entry.name, "service": entry.service,
                                 "started": entry.process.started.low | (entry.process.started.high << 32)}
                                for entry in owners[:count.value]]
        return report
    finally:
        report["end_status"] = api.RmEndSession(session)


def _report_cleanup_failure(error: OSError) -> None:
    """Recover the first sharing violation; owner sampling occurs after tempfile's fallback attempts."""
    current: BaseException | None = error
    sharing: OSError | None = None
    while current is not None:
        if isinstance(current, OSError) and getattr(current, "winerror", None) == 32 and current.filename:
            sharing = current
        current = current.__cause__ or current.__context__
    if sharing is None:
        return
    report: dict[str, object] = {"path": sharing.filename, "winerror": 32, "sample": "after-cleanup-fallback"}
    try:
        report["restart_manager"] = _windows_file_owners(str(sharing.filename))
    except Exception as diagnostic_error:
        report["diagnostic_failure"] = f"{type(diagnostic_error).__name__}: {diagnostic_error}"
    print("office-workspace-cleanup: " + json.dumps(report), file=sys.stderr)


@contextmanager
def workspace(artifacts: Path | None = None, *, prefix: str = "dsh-office-render-") -> Iterator[Path]:
    """Retain only Office inputs, PNG batches, and errors before cleaning the temporary root."""
    if artifacts is not None:
        artifacts.mkdir(parents=True, exist_ok=False)
    temporary = tempfile.TemporaryDirectory(prefix=prefix)
    try:
        root = Path(temporary.name).resolve()
        try:
            yield root
        except Exception as error:
            if artifacts is not None:
                (artifacts / "error.txt").write_text(f"{type(error).__name__}: {error}\n", encoding="utf-8")
            raise
        finally:
            if artifacts is not None:
                document = next(root.rglob("color-blocks.docx"), None)
                if document is not None:
                    source = document.parent
                    for name in ("color-blocks.docx", "color-blocks.pptx", "color-blocks.xlsx"):
                        if (source / name).is_file():
                            shutil.copy2(source / name, artifacts / name)
                    for name in ("cli-docx", "cli-pptx", "cli-xlsx", "node-pptx"):
                        batch = source / name
                        if batch.is_dir():
                            destination = artifacts / name
                            destination.mkdir()
                            for file in batch.iterdir():
                                if file.is_file() and (file.suffix == ".png" or file.name == "manifest.json"):
                                    shutil.copy2(file, destination / file.name)
    finally:
        try:
            temporary.cleanup()
        except OSError as error:
            try:
                _report_cleanup_failure(error)
            finally:
                raise error


def copy_documents(directory: Path) -> dict[str, Path]:
    """Copy the Kit's one-page color-block fixtures into a private test directory."""
    documents = {}
    for extension in ("docx", "pptx", "xlsx"):
        source = Path(__file__).with_suffix("") / f"color-blocks.{extension}"
        destination = directory / source.name
        shutil.copy2(source, destination)
        documents[extension] = destination
    return documents


def check_image(path: Path) -> None:
    """Require visible colored blocks and text after compositing transparency onto white."""
    from PIL import Image

    with Image.open(path) as image:
        rgba = image.convert("RGBA")
    visible = Image.alpha_composite(Image.new("RGBA", rgba.size, "white"), rgba).convert("RGB")
    red = blue = black = nonwhite = red_x = blue_x = 0
    for index, (r, g, b) in enumerate(visible.get_flattened_data()):
        x = index % visible.width
        if r >= 160 and g <= 100 and b <= 100:
            red += 1
            red_x += x
        if r <= 100 and g <= 160 and b >= 160:
            blue += 1
            blue_x += x
        black += max(r, g, b) < 80
        nonwhite += min(r, g, b) < 240
    pixels = visible.width * visible.height
    counts = {"red": red, "blue": blue, "black": black, "nonwhite": nonwhite, "pixels": pixels}
    if red < pixels * 0.01 or blue < pixels * 0.01 or black < pixels * 0.0002 or nonwhite < pixels * 0.04:
        raise AssertionError(f"Office image lacks visible color blocks or text: {path}: {counts}")
    if red_x / red + visible.width * 0.1 >= blue_x / blue:
        raise AssertionError(f"Office image has reversed or overlapping color blocks: {path}: {counts}")


def check_render_manifest(manifest: dict, expected_backend: str) -> Path:
    """Check direct-Office metadata and return its sole saved image path."""
    assert manifest["backend"] == expected_backend, manifest
    assert manifest["rasterEngine"] == "libreoffice", manifest
    assert manifest["source"] == "saved", manifest
    assert len(manifest["images"]) == 1, manifest
    return Path(manifest["images"][0]["path"])


def check_render(manifest: dict, expected_backend: str) -> None:
    """Check direct-Office metadata and visible content in its sole output image."""
    check_image(check_render_manifest(manifest, expected_backend))


def render_cli(
    command: Sequence[str], documents: Mapping[str, Path], directory: Path,
    expected_backend: str, environment: Mapping[str, str], *, check_content: bool = True,
) -> None:
    """Run the three document engines through the real CLI with isolated outputs."""
    errors = []
    for extension, document in documents.items():
        selection = ["--sheet", "Render", "--range", "A1:B2"] if extension == "xlsx" else ["--pages", "1"]
        try:
            result = subprocess.run([
                *command, "render", "--input", str(document), "--output-dir", str(directory / f"cli-{extension}"),
                "--dpi", "72", "--timeout-ms", "120000", *selection,
            ], env=environment, capture_output=True, text=True, encoding="utf-8", timeout=480)
            if result.returncode:
                raise AssertionError(f"exit {result.returncode}: {result.stderr}")
            manifest = json.loads(result.stdout)
            if check_content:
                check_render(manifest, expected_backend)
            else:
                check_render_manifest(manifest, expected_backend)
        except Exception as error:
            errors.append(f"{extension}: {type(error).__name__}: {error}")
    if errors:
        raise AssertionError("Office CLI content checks failed:\n" + "\n".join(errors))
