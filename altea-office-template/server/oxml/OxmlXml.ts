// XML <-> OxmlElement tree — now just altea core's generic parser/serializer under its OOXML names.
// See OxmlElement.server.ts for why it moved to `@altea/altea/server/xml/xmlDocument`.

export {
    XmlDocument as OxmlDocument,
    parseXmlDocument,
    serializeXmlDocument,
    serializeElement,
    decodeXmlEntities,
} from "@altea/altea/server/xml/xmlDocument";
