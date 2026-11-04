@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在打包 LBRFontWriter.exe ...
echo.

pyinstaller --noconfirm --clean --onefile --noconsole ^
  --name LBRFontWriter ^
  --distpath . --workpath build --specpath build ^
  font_write_gui.py

if errorlevel 1 goto :fail

echo.
echo 完成：%~dp0LBRFontWriter.exe
pause
exit /b 0

:fail
echo.
echo 打包失败，请检查上面的报错。
pause
exit /b 1
