{ pkgs }: {
  deps = [
    pkgs.nodejs-20_x
    pkgs.playwright-driver.browsers
  ];
  env = {
    PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  };
}
