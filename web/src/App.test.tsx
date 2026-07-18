/** @vitest-environment jsdom */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/preact";
import { I18nProvider } from "../../shared/i18n/context";

let TabBarComponent: typeof import("./App").TabBar;
let IconRailComponent: typeof import("./App").IconRail;

beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  const app = await import("./App");
  TabBarComponent = app.TabBar;
  IconRailComponent = app.IconRail;
});

afterEach(() => {
  cleanup();
});

describe("TabBar", () => {
  it("wraps dashboard tabs instead of forcing horizontal overflow on mobile", () => {
    const { container } = render(
      <I18nProvider>
        <TabBarComponent activeHash="#/accounts" />
      </I18nProvider>,
    );

    const tabBar = container.firstElementChild;
    expect(tabBar?.className).toContain("flex-wrap");
    expect(screen.getByText("Call Records").getAttribute("href")).toBe("#/call-records");
  });
});

describe("IconRail", () => {
  it("marks only the current navigation destination as active", () => {
    render(<IconRailComponent activeHash="#/accounts" />);

    expect(screen.getByLabelText("账号").classList.contains("active")).toBe(true);
    expect(screen.getByLabelText("调用大盘").classList.contains("active")).toBe(false);
    expect(screen.getByLabelText("账号").getAttribute("aria-current")).toBe("page");
  });

  it.each([
    ["#/", "调用大盘"],
    ["#/api-keys", "账号"],
    ["#/errors", "日志"],
    ["#/call-records", "调用记录"],
  ])("maps %s to its visible navigation parent", (hash, label) => {
    render(<IconRailComponent activeHash={hash} />);

    expect(screen.getByLabelText(label).getAttribute("aria-current")).toBe("page");
    expect(document.querySelectorAll(".icon-nav.active")).toHaveLength(1);
  });

  it("does not falsely mark the dashboard active for an unknown route", () => {
    render(<IconRailComponent activeHash="#/missing" />);

    expect(document.querySelectorAll(".icon-nav.active")).toHaveLength(0);
  });
});
