# Driver App Order State Persistence Fix

## Problem

In the driver app, an order could lose its progress when the driver returned to the Home screen using phone navigation.

Example flow:

1. Driver opens a new order.
2. Driver taps `Accept Order`.
3. Driver taps `Start Pickup`.
4. Driver taps `Mark as Picked Up`.
5. Driver navigates back to Home.

Before the fix, the app showed the same order as a fresh `New Order Available` again, forcing the driver to repeat the same actions.

## Root Cause

The app refreshes assigned orders when the driver returns to Home or Orders.

The method `refreshMyOrders()` in the Flutter delivery provider was resetting:

- the current order
- the delivery status
- the pickup location
- the driver position

So even though the driver had already accepted or picked up the order, the local app state was being reset to `waitingForAcceptance`.

Also, opening the same order again called `setCurrentOrder(order)`, which reset the delivery status back to the beginning.

## What Was Changed

### `lib/provider/delivery_provider.dart`

Added a new `hasActiveDelivery` getter to know when an order is already in progress.

Updated `refreshMyOrders()` so it preserves the active order state during refreshes instead of resetting it.

The provider now keeps:

- active order id
- current delivery status
- pickup location
- pickup address
- current driver position

If the backend refresh succeeds, the app merges the refreshed order data with the active local progress.

If the backend refresh fails, the app still keeps the active delivery instead of clearing it.

Updated `setCurrentOrder(order)` so tapping the same active order does not restart the flow.

### `lib/widgets/order_card.dart`

The Home screen order card now detects when the displayed order is already active.

When the driver is already delivering that order, the card shows:

- `Ongoing Order`
- `View ongoing order`

The close button is hidden for the ongoing order so the driver cannot accidentally dismiss the active delivery from the Home widget.

### `lib/screen/order_detail_screen.dart`

The order detail screen now checks the delivery status.

If the order is already past the accept stage, the bottom button shows:

`Continue Delivery`

This prevents the screen from showing `Accept Order` and `Decline Order` again for an order that is already being delivered.

## Result

The driver only needs to click each delivery action once.

Returning to Home no longer restarts the order flow. The Home widget remembers the active delivery and displays it as ongoing.

## Verification

`git diff --check` passed for the modified Flutter files.

`dart format` and `flutter analyze` could not complete because the local Dart/Flutter command processes were hanging in the workspace.
