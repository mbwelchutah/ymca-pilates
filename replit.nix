{ pkgs }: {
  deps = [
    pkgs.nodejs-20_x
    pkgs.chromium
  ];
  env = {
    CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  };
}
