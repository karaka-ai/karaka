"""Reject unreadable Office output independently of the selected native engine."""

from __future__ import annotations

import builtins
import runpy
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw


CHECKS = runpy.run_path(Path(__file__).resolve().parents[3] / "scripts/fixtures/office-render.py")


def test_fixture_load_does_not_require_pillow(monkeypatch: pytest.MonkeyPatch) -> None:
    original_import = builtins.__import__

    def blocked_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "PIL" or name.startswith("PIL."):
            raise ModuleNotFoundError(name)
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    loaded = runpy.run_path(Path(__file__).resolve().parents[3] / "scripts/fixtures/office-render.py")
    assert callable(loaded["check_render_manifest"])


def content_image() -> Image.Image:
    image = Image.new("RGBA", (400, 200), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 180, 160), fill=(215, 48, 39))
    draw.rectangle((220, 20, 380, 160), fill=(35, 111, 194))
    draw.rectangle((30, 170, 370, 180), fill="black")
    return image


@pytest.mark.parametrize("invalid", [None, "white", "transparent", "swapped", "no-text"])
def test_content_guard_checks_visible_colors_and_order(tmp_path: Path, invalid: str | None) -> None:
    image = content_image()
    if invalid == "white":
        image = Image.new("RGBA", image.size, "white")
    elif invalid == "transparent":
        image.putalpha(0)
    elif invalid == "swapped":
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif invalid == "no-text":
        ImageDraw.Draw(image).rectangle((0, 165, 399, 199), fill="white")
    path = tmp_path / "page.png"
    image.save(path)
    if invalid is None:
        CHECKS["check_image"](path)
    else:
        with pytest.raises(AssertionError, match="Office image"):
            CHECKS["check_image"](path)


@pytest.mark.parametrize("invalid", [None, "backend", "rasterEngine", "source", "images"])
def test_manifest_guard_requires_direct_native_office(tmp_path: Path, invalid: str | None) -> None:
    path = tmp_path / "page.png"
    content_image().save(path)
    manifest = {"backend": "native", "rasterEngine": "libreoffice", "source": "saved", "images": [{"path": str(path)}]}
    if invalid:
        manifest[invalid] = [] if invalid == "images" else "other"
        with pytest.raises(AssertionError):
            CHECKS["check_render"](manifest, "native")
    else:
        CHECKS["check_render"](manifest, "native")


@pytest.mark.parametrize("fails", [False, True])
def test_workspace_retains_only_render_evidence_and_cleans_its_root(tmp_path: Path, fails: bool) -> None:
    artifacts = tmp_path / "artifacts"
    try:
        with CHECKS["workspace"](artifacts) as root:
            inputs = root / "relocated"
            inputs.mkdir()
            CHECKS["copy_documents"](inputs)
            batch = inputs / "cli-docx"
            batch.mkdir()
            content_image().save(batch / "page.png")
            (batch / "manifest.json").write_text("{}")
            (batch / "not-render-evidence.txt").write_text("excluded")
            (root / "runtime.bin").write_bytes(b"excluded")
            if fails:
                raise AssertionError("render failed")
    except AssertionError as error:
        assert fails and str(error) == "render failed"
    assert not root.exists()
    assert len(list(artifacts.glob("color-blocks.*"))) == 3
    assert sorted(file.name for file in (artifacts / "cli-docx").iterdir()) == ["manifest.json", "page.png"]
    assert not (artifacts / "runtime.bin").exists()
    assert (artifacts / "error.txt").exists() == fails


def test_cli_checks_every_format_before_reporting_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    documents = CHECKS["copy_documents"](tmp_path)
    calls = []

    def failed_command(arguments: list[str], **options: object) -> SimpleNamespace:
        calls.append(Path(arguments[arguments.index("--input") + 1]).suffix)
        return SimpleNamespace(returncode=7, stderr="engine failed", stdout="")

    monkeypatch.setattr(CHECKS["subprocess"], "run", failed_command)
    with pytest.raises(AssertionError) as failure:
        CHECKS["render_cli"](["kit"], documents, tmp_path, "native", {})
    assert calls == [".docx", ".pptx", ".xlsx"]
    for extension in documents:
        assert f"{extension}: AssertionError: exit 7: engine failed" in str(failure.value)


def test_cli_can_check_metadata_without_pillow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    document = tmp_path / "input.docx"
    document.write_bytes(b"fixture")
    manifest = {
        "backend": "native", "rasterEngine": "libreoffice", "source": "saved",
        "images": [{"path": str(tmp_path / "page.png")}],
    }

    monkeypatch.setattr(
        CHECKS["subprocess"], "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stderr="", stdout=CHECKS["json"].dumps(manifest)),
    )
    monkeypatch.setitem(CHECKS, "check_image", lambda path: pytest.fail(f"unexpected pixel check: {path}"))
    CHECKS["render_cli"](["kit"], {"docx": document}, tmp_path, "native", {}, check_content=False)


def sharing_error(path: Path) -> PermissionError:
    error = PermissionError(13, "file is in use", str(path))
    error.winerror = 32
    return error


@pytest.mark.parametrize("failure", [None, "ordinary", "sharing", "fallback"])
def test_workspace_reports_only_sharing_failures_and_preserves_error_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], failure: str | None,
) -> None:
    original = sharing_error(tmp_path / "first.exe") if failure in ("sharing", "fallback") else OSError("cleanup failed")
    error = original
    if failure == "fallback":
        second = sharing_error(tmp_path / "fallback.exe")
        second.__context__ = original
        error = NotADirectoryError("tempfile fallback failed")
        error.__context__ = second
    cleanups = []
    observations = []

    class Temporary:
        name = str(tmp_path)

        def __init__(self, **options: object) -> None:
            pass

        def cleanup(self) -> None:
            cleanups.append(True)
            if failure is not None:
                raise error

    def owners(path: str) -> dict[str, object]:
        observations.append(path)
        return {"status": 0, "owners": [{"pid": 17}]}

    namespace = CHECKS["_report_cleanup_failure"].__globals__
    with monkeypatch.context() as patch:
        patch.setattr(CHECKS["tempfile"], "TemporaryDirectory", Temporary)
        patch.setitem(namespace, "_windows_file_owners", owners)
        if failure is None:
            with CHECKS["workspace"]() as root:
                assert root == tmp_path
        else:
            with pytest.raises(OSError) as raised:
                with CHECKS["workspace"]():
                    pass
            assert raised.value is error
    assert cleanups == [True]
    output = capsys.readouterr().err
    if failure in ("sharing", "fallback"):
        assert observations == [str(tmp_path / "first.exe")]
        report = CHECKS["json"].loads(output.removeprefix("office-workspace-cleanup: "))
        assert report == {"path": str(tmp_path / "first.exe"), "winerror": 32,
                          "sample": "after-cleanup-fallback", "restart_manager": {"status": 0, "owners": [{"pid": 17}]}}
    else:
        assert observations == []
        assert output == ""


def test_workspace_diagnostic_failure_does_not_replace_cleanup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    original = sharing_error(tmp_path / "locked.exe")

    class Temporary:
        name = str(tmp_path)

        def __init__(self, **options: object) -> None:
            pass

        def cleanup(self) -> None:
            raise original

    def unavailable(path: str) -> dict[str, object]:
        raise OSError("Restart Manager unavailable")

    with monkeypatch.context() as patch:
        patch.setattr(CHECKS["tempfile"], "TemporaryDirectory", Temporary)
        patch.setitem(CHECKS["_report_cleanup_failure"].__globals__, "_windows_file_owners", unavailable)
        with pytest.raises(PermissionError) as raised:
            with CHECKS["workspace"]():
                pass
        assert raised.value is original
    assert "OSError: Restart Manager unavailable" in capsys.readouterr().err


@pytest.mark.parametrize("failure", [None, "start", "register", "list", "more-data", "exception"])
def test_restart_manager_observation_is_bounded_and_ends_acquired_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str | None,
) -> None:
    import ctypes

    calls = []
    path = str(tmp_path / "libreoffice-kit.exe")

    def start(session: object, flags: int, key: object) -> int:
        calls.append("start")
        assert flags == 0 and len(key) == 33
        session._obj.value = 17
        return 5 if failure == "start" else 0

    def register(session: object, count: int, files: object, processes: int,
                 applications: object, services: int, names: object) -> int:
        calls.append("register")
        assert session.value == 17 and count == 1 and files[0] == path
        assert (processes, applications, services, names) == (0, None, 0, None)
        if failure == "exception":
            raise OSError("registration failed")
        return 5 if failure == "register" else 0

    def get_list(session: object, needed: object, count: object, owners: object, reasons: object) -> int:
        calls.append("list")
        assert session.value == 17 and count._obj.value == len(owners) == 32
        needed._obj.value = 33 if failure == "more-data" else 1
        count._obj.value = 1
        owners[0].process.pid = 31
        owners[0].process.started.low = 7
        owners[0].process.started.high = 2
        owners[0].name = "LibreOffice helper"
        owners[0].service = ""
        return 234 if failure == "more-data" else 5 if failure == "list" else 0

    def end(session: object) -> int:
        calls.append("end")
        assert session.value == 17
        return 0

    api = SimpleNamespace(RmStartSession=start, RmRegisterResources=register, RmGetList=get_list, RmEndSession=end)
    monkeypatch.setattr(ctypes, "WinDLL", lambda name: api, raising=False)
    if failure == "exception":
        with pytest.raises(OSError, match="registration failed"):
            CHECKS["_windows_file_owners"](path)
    else:
        report = CHECKS["_windows_file_owners"](path)
        if failure is None:
            assert report == {"stage": "list", "status": 0, "needed": 1, "reboot_reasons": 0,
                              "owners": [{"pid": 31, "name": "LibreOffice helper", "service": "", "started": (2 << 32) | 7}],
                              "end_status": 0}
        elif failure == "start":
            assert report == {"stage": "start", "status": 5}
        else:
            assert report["status"] == (234 if failure == "more-data" else 5)
            assert report["end_status"] == 0
            assert "owners" not in report
    assert calls == (["start"] if failure == "start" else
                     ["start", "register", "end"] if failure in ("register", "exception") else
                     ["start", "register", "list", "end"])


def test_workspace_body_sharing_error_does_not_query_cleanup_owners(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    original = sharing_error(tmp_path / "input.docx")

    def unexpected(path: str) -> dict[str, object]:
        pytest.fail(f"owner lookup outside cleanup: {path}")

    monkeypatch.setitem(CHECKS["_report_cleanup_failure"].__globals__, "_windows_file_owners", unexpected)
    with pytest.raises(PermissionError) as raised:
        with CHECKS["workspace"]():
            raise original
    assert raised.value is original
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("diagnostic_type", [RuntimeError, OSError])
def test_workspace_reporter_failure_preserves_cleanup_error_and_diagnostic_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, diagnostic_type: type[Exception],
) -> None:
    original = sharing_error(tmp_path / "locked.exe")
    diagnostic = diagnostic_type("diagnostic stream unavailable")

    class Temporary:
        name = str(tmp_path)

        def __init__(self, **options: object) -> None:
            pass

        def cleanup(self) -> None:
            raise original

    def broken_reporter(error: OSError) -> None:
        assert error is original
        raise diagnostic

    with monkeypatch.context() as patch:
        patch.setattr(CHECKS["tempfile"], "TemporaryDirectory", Temporary)
        patch.setitem(CHECKS["_report_cleanup_failure"].__globals__, "_report_cleanup_failure", broken_reporter)
        with pytest.raises(PermissionError) as raised:
            with CHECKS["workspace"]():
                pass
        assert raised.value is original
        assert raised.value.__context__ is diagnostic
