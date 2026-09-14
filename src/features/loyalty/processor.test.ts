import { describe,expect,it } from "vitest";
import { belongsToHotel,campaignDeliveryKey,evaluateAtSend,postStayDeliveryKey } from "./processor";
const candidate={hotelId:"A",customerId:"C",email:"a@b.fr",marketingAllowed:true,hotelExcluded:false,customerUnsubscribed:false};
describe("loyalty processing rules",()=>{
 it("supports general and targeted eligible recipients with the same send-time gate",()=>{expect(evaluateAtSend(candidate,"marketing")).toEqual({eligible:true});});
 it("honours a status change after scheduling",()=>{expect(evaluateAtSend({...candidate,hotelExcluded:true},"marketing")).toEqual({eligible:false,reason:"hotel_excluded"});});
 it("creates stable idempotency keys",()=>{expect(campaignDeliveryKey("X","C")).toBe(campaignDeliveryKey("X","C"));expect(postStayDeliveryKey("S")).toBe("post-stay:S");});
 it("supports post-stay without deriving anything from spa bookings",()=>{expect(evaluateAtSend({...candidate,marketingAllowed:false},"post_stay")).toEqual({eligible:true});expect(postStayDeliveryKey("hotel-stay-id")).not.toContain("spa");});
 it("rejects cross-hotel candidates",()=>{expect(belongsToHotel(candidate,"B")).toBe(false);});
});

